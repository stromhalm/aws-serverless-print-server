#!/usr/bin/env node

const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
const { SQSClient, ListQueuesCommand } = require('@aws-sdk/client-sqs');

async function checkAWSSetup() {
  console.log('🔍 Checking AWS setup...\n');

  // Check environment variables
  console.log('📋 Environment Variables:');
  console.log(`   CLIENT_ID: ${process.env.CLIENT_ID || 'NOT SET'}`);
  console.log(`   S3_BUCKET_NAME: ${process.env.S3_BUCKET_NAME || 'NOT SET'}`);
  console.log(`   AWS_REGION: ${process.env.AWS_REGION || 'NOT SET (will default to us-east-1)'}`);
  console.log(`   AWS_PROFILE: ${process.env.AWS_PROFILE || 'NOT SET (will use default)'}\n`);

  // Check AWS credentials
  try {
    console.log('🔑 Testing AWS credentials...\n');

    // Test S3 access
    const s3Client = new S3Client();
    const s3Response = await s3Client.send(new ListBucketsCommand({}));
    console.log('✅ S3 access: OK');

    // Test SQS access
    const sqsClient = new SQSClient();
    const sqsResponse = await sqsClient.send(new ListQueuesCommand({}));
    console.log('✅ SQS access: OK\n');

    console.log('🎉 AWS setup looks good!');
    console.log('\nNext steps:');
    console.log('1. Make sure your CDK stack is deployed');
    console.log('2. Upload a test file to create the queue');
    console.log('3. Run: npm start');

  } catch (error) {
    console.log('❌ AWS setup issue:', error.message);
    console.log('\nTroubleshooting:');
    console.log('1. Run: aws configure (if using access keys)');
    console.log('2. Or set AWS_PROFILE if using named profiles');
    console.log('3. Make sure your AWS credentials have the right permissions');
    process.exit(1);
  }
}

if (require.main === module) {
  checkAWSSetup().catch(console.error);
}

module.exports = { checkAWSSetup };
