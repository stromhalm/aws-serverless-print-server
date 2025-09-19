#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsServerlessPrintserverStack } from './aws-serverless-printserver-stack';

const app = new cdk.App();
new AwsServerlessPrintserverStack(app, 'AwsServerlessPrintserverStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
