import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
export class AwsServerlessPrintserverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get configurable retention time (default: 720 hours = 30 days)
    const fileRetentionHours = this.node.tryGetContext('fileRetentionHours') || 720;

    // S3 Bucket for print files
    const printBucket = new s3.Bucket(this, 'PrintFilesBucket', {
      bucketName: `printserver-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Delete bucket on stack deletion
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{
        enabled: true,
        expiration: cdk.Duration.hours(fileRetentionHours),
      }],
    });

    // Template SQS FIFO queue for client-specific queues (printserver-{clientId}.fifo)
    // This is used only for permissions policy against 'printserver-*' pattern
    const templateQueue = new sqs.Queue(this, 'PrintQueueTemplate', {
      queueName: 'printserver-template.fifo',
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(1),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Allow S3 bucket notifications to send to all client queues
    templateQueue.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [`arn:aws:sqs:${this.region}:${this.account}:printserver-*`],
      conditions: {
        ArnEquals: { 'aws:SourceArn': printBucket.bucketArn }
      }
    }));

    // IAM Policy for client applications
    const clientPolicy = new iam.ManagedPolicy(this, 'PrintClientPolicy', {
      managedPolicyName: 'PrintServerClientPolicy',
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            's3:GetObject',
            's3:ListBucket',
          ],
          resources: [
            printBucket.bucketArn,
            `${printBucket.bucketArn}/*`,
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl',
          ],
          resources: [
            `arn:aws:sqs:${this.region}:${this.account}:printserver-*`, // Allow access to all client-specific queues
          ],
        }),
      ],
    });

    // Output important values
    new cdk.CfnOutput(this, 'PrintBucketName', {
      value: printBucket.bucketName,
      description: 'S3 bucket name for uploading print files',
    });

    new cdk.CfnOutput(this, 'QueueNamingPattern', {
      value: 'printserver-{clientId}',
      description: 'Queue naming pattern: printserver-{clientId} (created dynamically)',
    });


    new cdk.CfnOutput(this, 'ClientPolicyArn', {
      value: clientPolicy.managedPolicyArn,
      description: 'IAM policy ARN for client applications',
    });

    new cdk.CfnOutput(this, 'FileRetentionHours', {
      value: fileRetentionHours.toString(),
      description: 'File retention time in hours before automatic deletion',
    });
  }
}
