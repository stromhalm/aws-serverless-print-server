import { describe, test, expect, beforeEach, vi } from 'vitest'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import * as AwsServerlessPrintserver from './aws-serverless-printserver-stack'

// Mock AWS SDK for CDK tests
vi.mock('aws-cdk-lib/aws-s3', () => ({
  Bucket: vi.fn().mockImplementation(() => ({
    bucketArn: 'arn:aws:s3:::test-bucket',
    bucketName: 'test-bucket',
  })),
  BucketEncryption: {
    S3_MANAGED: 'AES256'
  }
}))

vi.mock('aws-cdk-lib/aws-sqs', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    queueArn: 'arn:aws:sqs:us-east-1:123456789012:test-queue',
    queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue',
  })),
  QueueEncryption: {
    KMS_MANAGED: 'KMS_MANAGED'
  }
}))

describe('AWS Serverless Print Server Stack', () => {
  let app: cdk.App
  let stack: AwsServerlessPrintserver.AwsServerlessPrintserverStack
  let template: Template

  beforeEach(() => {
    app = new cdk.App()
    stack = new AwsServerlessPrintserver.AwsServerlessPrintserverStack(app, 'TestStack')
    template = Template.fromStack(stack)
  })

  test('creates S3 bucket with encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256'
            }
          }
        ]
      }
    })
  })

  test('creates S3 bucket with lifecycle rules', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            Status: 'Enabled',
            ExpirationInDays: 1
          }
        ]
      }
    })
  })

  test('creates SQS template queue with proper configuration', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'printserver-template',
      VisibilityTimeout: 300,
      MessageRetentionPeriod: 604800
    })
  })

  test('creates IAM managed policy for client access', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: expect.arrayContaining([
          expect.objectContaining({
            Effect: 'Allow',
            Action: expect.arrayContaining([
              's3:PutObject',
              's3:GetObject',
              's3:DeleteObject'
            ])
          }),
          expect.objectContaining({
            Effect: 'Allow',
            Action: expect.arrayContaining([
              'sqs:ReceiveMessage',
              'sqs:DeleteMessage'
            ])
          })
        ])
      }
    })
  })

  test('exports important values', () => {
    const outputs = template.findOutputs('*')
    expect(outputs).toHaveProperty('PrintBucketName')
    expect(outputs).toHaveProperty('QueueNamingPattern')
    expect(outputs).toHaveProperty('ClientPolicyArn')
  })
})
