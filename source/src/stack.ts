import * as ec2 from '@aws-cdk/aws-ec2';
import { Construct, Stack, StackProps, CfnParameter, CfnParameterProps, Fn, Aws, Duration } from '@aws-cdk/core';
import { KeyCloak, KeycloakVersion } from './keycloak';

export class SolutionStack extends Stack {
  private _paramGroup: { [grpname: string]: CfnParameter[]} = {}

  protected setDescription(description: string) { this.templateOptions.description = description; }
  protected makeParam(id: string, props?: CfnParameterProps): CfnParameter { return new CfnParameter(this, id, props); }
  protected addGroupParam(props: { [key: string]: CfnParameter[]}): void {
    for (const key of Object.keys(props)) {
      const params = props[key];
      this._paramGroup[key] = params.concat(this._paramGroup[key] ?? []);
    }
    this._setParamGroups();
  }
  private _setParamGroups(): void {
    if (!this.templateOptions.metadata) { this.templateOptions.metadata = {}; }
    const mkgrp = (label: string, params: CfnParameter[]) => {
      return {
        Label: { default: label },
        Parameters: params.map(p => {
          return p ? p.logicalId : '';
        }).filter(id => id),
      };
    };
    this.templateOptions.metadata['AWS::CloudFormation::Interface'] = {
      ParameterGroups: Object.keys(this._paramGroup).map(key => mkgrp(key, this._paramGroup[key]) ),
    };
  }
}

interface KeycloakStackProps extends StackProps {
  readonly auroraServerless?: boolean;
  readonly fromExistingVPC?: boolean;
}

interface KeycloakSettings {
  certificateArn: string;
  vpc?: ec2.IVpc;
  publicSubnets?: ec2.SubnetSelection;
  privateSubnets?: ec2.SubnetSelection;
  databaseSubnets?: ec2.SubnetSelection;
  databaseInstanceType?: ec2.InstanceType;
}

export class KeycloakStack extends SolutionStack {
  private _keycloakSettings: KeycloakSettings = { certificateArn: '' };

  constructor(scope: Construct, id: string, props: KeycloakStackProps = {}) {
    super(scope, id, props);

    const dbMsg = props.auroraServerless ? 'using aurora serverless' : 'rds mysql';
    const vpcMsg = props.fromExistingVPC ? 'existing vpc' : 'new vpc';

    this.setDescription(`(SO8021) - Deploy keycloak ${dbMsg} with ${vpcMsg}. template version: ${process.env.VERSION}`);

    const certificateArnParam = this.makeParam('CertificateArn', {
      type: 'String',
      description: 'Certificate Arn for Application Load Balancer',
      minLength: 5,
    });

    this.addGroupParam({ 'Application Load Balancer Settings': [certificateArnParam] });

    this._keycloakSettings.certificateArn = certificateArnParam.valueAsString;

    if (!props.auroraServerless) {
      const databaseInstanceType = this.makeParam('DatabaseInstanceType', {
        type: 'String',
        description: 'Instance type to be used for the core instances',
        allowedValues: INSTANCE_TYPES,
        default: 'r5.large',
      });
      this.addGroupParam({ 'Database Instance Settings': [databaseInstanceType] });
      this._keycloakSettings.databaseInstanceType = new ec2.InstanceType(databaseInstanceType.valueAsString);
    }

    if (props.fromExistingVPC) {
      const vpcIdParam = this.makeParam('VpcId', {
        type: 'AWS::EC2::VPC::Id',
        description: 'Your VPC Id',
      });
      const pubSubnetsParam = this.makeParam('PubSubnets', {
        type: 'List<AWS::EC2::Subnet::Id>',
        description: 'Public subnets (Choose two)',
      });
      const privSubnetsParam = this.makeParam('PrivSubnets', {
        type: 'List<AWS::EC2::Subnet::Id>',
        description: 'Private subnets (Choose two)',
      });
      const dbSubnetsParam = this.makeParam('DBSubnets', {
        type: 'List<AWS::EC2::Subnet::Id>',
        description: 'Database subnets (Choose two)',
      });
      this.addGroupParam({ 'VPC Settings': [vpcIdParam, pubSubnetsParam, privSubnetsParam, dbSubnetsParam] });

      const azs = ['a', 'b'];
      const vpc = ec2.Vpc.fromVpcAttributes(this, 'VpcAttr', {
        vpcId: vpcIdParam.valueAsString,
        vpcCidrBlock: Aws.NO_VALUE,
        availabilityZones: azs,
        publicSubnetIds: azs.map((_, index) => Fn.select(index, pubSubnetsParam.valueAsList)),
        privateSubnetIds: azs.map((_, index) => Fn.select(index, privSubnetsParam.valueAsList)),
        isolatedSubnetIds: azs.map((_, index) => Fn.select(index, dbSubnetsParam.valueAsList)),
      });

      Object.assign(this._keycloakSettings, {
        vpc,
        publicSubnets: { subnets: vpc.publicSubnets },
        privateSubnets: { subnets: vpc.privateSubnets },
        databaseSubnets: { subnets: vpc.isolatedSubnets },
      });
    }

    const minContainersParam = this.makeParam('MinContainers', {
      type: 'Number',
      description: 'minimum containers count',
      default: 2,
      minValue: 2,
    });
    const maxContainersParam = this.makeParam('MaxContainers', {
      type: 'Number',
      description: 'maximum containers count',
      default: 10,
      minValue: 2,
    });
    const targetCpuUtilizationParam = this.makeParam('AutoScalingTargetCpuUtilization', {
      type: 'Number',
      description: 'Auto scaling target cpu utilization',
      default: 75,
      minValue: 0,
    });
    this.addGroupParam({ 'AutoScaling Settings': [minContainersParam, maxContainersParam, targetCpuUtilizationParam] });

    const javaOptsParam = this.makeParam('JavaOpts', {
      type: 'String',
      description: 'JAVA_OPTS environment variable',
    });
    this.addGroupParam({ 'Environment variable': [javaOptsParam] });

    const keycloakVersion = this.makeParam('Keycloak Version', {
      type: 'String',
      description: `List of Versions 
        ${KeycloakVersion.V12_0_4}, 
        ${KeycloakVersion.V15_0_0},
        ${KeycloakVersion.V15_0_1},
        ${KeycloakVersion.V15_0_2},
        ${KeycloakVersion.cbV15_0_2}
        `,
      default: "cb.15.0.2",
    })

    this.addGroupParam({ 'Keycloak Version': [keycloakVersion] });




    new KeyCloak(this, 'KeyCloak', {
      vpc: this._keycloakSettings.vpc,
      publicSubnets: this._keycloakSettings.publicSubnets,
      privateSubnets: this._keycloakSettings.privateSubnets,
      databaseSubnets: this._keycloakSettings.databaseSubnets,
      certificateArn: this._keycloakSettings.certificateArn,
      auroraServerless: props.auroraServerless,
      databaseInstanceType: this._keycloakSettings.databaseInstanceType,
      stickinessCookieDuration: Duration.days(7),
      nodeCount: minContainersParam.valueAsNumber,
      autoScaleTask: {
        min: minContainersParam.valueAsNumber,
        max: maxContainersParam.valueAsNumber,
        targetCpuUtilization: targetCpuUtilizationParam.valueAsNumber,
      },
      env: {
        JAVA_OPTS: javaOptsParam.valueAsString,
      },
      keycloakVersion: KeycloakVersion.of(keycloakVersion.valueAsString),
    });
  }

}


const INSTANCE_TYPES = [
  'm5.large',
  'm5.xlarge',
  'm5.2xlarge',
  'm5.4xlarge',
  'm5.8xlarge',
  'm5a.xlarge',
  'm5a.2xlarge',
  'm5a.4xlarge',
  'm5a.8xlarge',
  'm5d.xlarge',
  'm5d.2xlarge',
  'm5d.4xlarge',
  'm5d.8xlarge',
  'm6g.xlarge',
  'm6g.2xlarge',
  'm6g.4xlarge',
  'm6g.8xlarge',
  'c5.xlarge',
  'c5.2xlarge',
  'c5.4xlarge',
  'c5.9xlarge',
  'c5d.xlarge',
  'c5d.2xlarge',
  'c5d.4xlarge',
  'c5d.9xlarge',
  'c5n.xlarge',
  'c5n.2xlarge',
  'c5n.4xlarge',
  'c5n.9xlarge',
  'c6g.xlarge',
  'c6g.2xlarge',
  'c6g.4xlarge',
  'c6g.8xlarge',
  'cc2.8xlarge',
  'z1d.xlarge',
  'z1d.2xlarge',
  'z1d.3xlarge',
  'z1d.6xlarge',
  'r5.large',
  'r5.xlarge',
  'r5.2xlarge',
  'r5.4xlarge',
  'r5.8xlarge',
  'r5a.xlarge',
  'r5a.2xlarge',
  'r5a.4xlarge',
  'r5a.8xlarge',
  'r5d.xlarge',
  'r5d.2xlarge',
  'r5d.4xlarge',
  'r5d.8xlarge',
  'r6g.xlarge',
  'r6g.2xlarge',
  'r6g.4xlarge',
  'r6g.8xlarge',
  'cr1.8xlarge',
  'i3.xlarge',
  'i3.2xlarge',
  'i3.4xlarge',
  'i3.8xlarge',
  'i3en.xlarge',
  'i3en.2xlarge',
  'i3en.3xlarge',
  'i3en.6xlarge',
  'd2.xlarge',
  'd2.2xlarge',
  'd2.4xlarge',
  'd2.8xlarge',
  'g4dn.xlarge',
  'g4dn.2xlarge',
  'g4dn.4xlarge',
  'g4dn.8xlarge',
  'p2.xlarge',
  'p2.8xlarge',
  'p3.2xlarge',
  'p3.8xlarge',
];
