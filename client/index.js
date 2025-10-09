// Load environment variables from .env file if it exists
// Check both current directory and client directory
const path = require('path');
const fs = require('fs');

let envPath = '.env';
if (!fs.existsSync(envPath)) {
  // Try client directory
  envPath = path.join(__dirname, '.env');
}
require('dotenv').config({ path: envPath });

// AWS SDK imports
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, GetQueueUrlCommand, CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand, DeleteQueueCommand } = require('@aws-sdk/client-sqs');
const { S3Client, GetObjectCommand, PutObjectCommand, PutBucketNotificationConfigurationCommand, GetBucketNotificationConfigurationCommand } = require('@aws-sdk/client-s3');
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const argv = require('minimist')(process.argv.slice(2));

// Shared AWS clients for long-running mode
let sharedSqsClient;
let sharedS3Client;
let sharedStsClient;

function getSqsClient(context = {}) {
  if (context.sqsClient) return context.sqsClient;
  if (!sharedSqsClient) sharedSqsClient = new SQSClient();
  return sharedSqsClient;
}

function getS3Client(context = {}) {
  if (context.s3Client) return context.s3Client;
  if (!sharedS3Client) sharedS3Client = new S3Client();
  return sharedS3Client;
}

function getStsClient(context = {}) {
  if (context.stsClient) return context.stsClient;
  if (!sharedStsClient) sharedStsClient = new STSClient();
  return sharedStsClient;
}

function createTemporaryAwsClients({ sqs = false, s3 = false, sts = false } = {}) {
  const context = {};
  if (sqs) context.sqsClient = new SQSClient();
  if (s3) context.s3Client = new S3Client();
  if (sts) context.stsClient = new STSClient();
  return context;
}

function destroyTemporaryAwsClients(context = {}) {
  if (context.sqsClient && typeof context.sqsClient.destroy === 'function') context.sqsClient.destroy();
  if (context.s3Client && typeof context.s3Client.destroy === 'function') context.s3Client.destroy();
  if (context.stsClient && typeof context.stsClient.destroy === 'function') context.stsClient.destroy();
}

// Upload print job function
async function uploadPrintJob(filePath, clientId, printerId, printOptions = '') {
  const context = createTemporaryAwsClients({ s3: true, sts: true });
  const hadTimerRunning = Boolean(idempotencyCleanupHandle);
  if (hadTimerRunning) stopIdempotencyCleanupTimer();
  try {
    // Read file
    const fileContent = fs.readFileSync(filePath);
    const filename = path.basename(filePath);

    // Construct S3 key (printer ID is now in metadata, not path)
    const key = `clients/${clientId}/${filename}`;

    // Prepare metadata
    const metadata = {};
    if (printerId) {
      metadata['printer'] = printerId;
    }
    if (printOptions) {
      metadata['print-options'] = printOptions;
    }

    // Upload to S3
    const bucketName = await getResolvedBucketName(context);
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileContent,
      Metadata: metadata
    });

    await getS3Client(context).send(command);

    console.log(`📤 Uploaded: s3://${bucketName}/${key}`);
    console.log(`🖨️  Printer: ${printerId}`);
    console.log(`⚙️  Options: ${printOptions || 'none'}`);
    console.log(`🔄 S3 notification will route to: printserver-${clientId}`);

    return {
      success: true,
      bucket: bucketName,
      key: key
    };

  } catch (error) {
    console.error('❌ Upload failed:', error);
    return {
      success: false,
      error: error.message,
    };
  } finally {
    destroyTemporaryAwsClients(context);
    if (hadTimerRunning) startIdempotencyCleanupTimer();
  }
}

// Handle graceful shutdown
let isShuttingDown = false;
let activeProcessingCount = 0;

process.on('SIGINT', () => {
  console.log('\n^CReceived SIGINT, shutting down gracefully...');
  isShuttingDown = true;

  if (activeProcessingCount > 0) {
    console.log(`Currently processing ${activeProcessingCount} message(s), will exit after completion...`);
    // Don't exit immediately, let the finally block in processMessage handle it
  } else {
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  isShuttingDown = true;

  if (activeProcessingCount > 0) {
    console.log(`Currently processing ${activeProcessingCount} message(s), will exit after completion...`);
    // Don't exit immediately, let the finally block in processMessage handle it
  } else {
    process.exit(0);
  }
});

// Configuration
const CLIENT_ID = process.env.CLIENT_ID || 'default-client';
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || null; // optional; auto-resolved if not set
const TEST_MODE = argv.test || process.env.TEST_MODE === 'true';

// Idempotency cache: track processed S3 keys to prevent duplicate printing
// Key: S3 object key, Value: timestamp when processed
const processedKeys = new Map();
const IDEMPOTENCY_CACHE_DURATION = 3600000; // 1 hour in milliseconds
let idempotencyCleanupHandle = null;

function startIdempotencyCleanupTimer() {
  if (idempotencyCleanupHandle) return;
  idempotencyCleanupHandle = setInterval(() => {
    const now = Date.now();
    const expiredKeys = [];
    for (const [key, timestamp] of processedKeys.entries()) {
      if (now - timestamp > IDEMPOTENCY_CACHE_DURATION) {
        expiredKeys.push(key);
      }
    }
    expiredKeys.forEach(key => processedKeys.delete(key));
    if (expiredKeys.length > 0) {
      console.log(`🧹 Cleaned ${expiredKeys.length} expired idempotency entries`);
    }
  }, 300000); // Clean every 5 minutes
}

function stopIdempotencyCleanupTimer() {
  if (idempotencyCleanupHandle) {
    clearInterval(idempotencyCleanupHandle);
    idempotencyCleanupHandle = null;
  }
}

// --- Auto bucket resolution helpers ---
let resolvedBucketNameCache = null;

async function resolveRegionFromClient(client) {
  try {
    const regionProvider = client.config.region;
    const region = typeof regionProvider === 'function' ? await regionProvider() : regionProvider;
    return region || process.env.AWS_REGION || 'us-east-1';
  } catch {
    return process.env.AWS_REGION || 'us-east-1';
  }
}

async function getAccountId(context = {}) {
  const res = await getStsClient(context).send(new GetCallerIdentityCommand({}));
  return res.Account;
}

async function getResolvedBucketName(context = {}) {
  if (S3_BUCKET_NAME) return S3_BUCKET_NAME;
  if (resolvedBucketNameCache) return resolvedBucketNameCache;
  const [accountId, region] = await Promise.all([
    getAccountId(context),
    resolveRegionFromClient(getS3Client(context))
  ]);
  const name = `printserver-${accountId}-${region}`;
  resolvedBucketNameCache = name;
  return name;
}

function getRegionFromQueueUrl(queueUrl) {
  try {
    const match = queueUrl.match(/^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\//);
    return match ? match[1] : (process.env.AWS_REGION || null);
  } catch {
    return process.env.AWS_REGION || null;
  }
}

// Client registration function
async function registerClient(clientId) {
  const tempClients = sharedSqsClient || sharedS3Client || sharedStsClient
    ? { sqsClient: sharedSqsClient, s3Client: sharedS3Client, stsClient: sharedStsClient }
    : createTemporaryAwsClients({ sqs: true, s3: true, sts: true });
  const hadTimerRunning = Boolean(idempotencyCleanupHandle);
  if (hadTimerRunning) stopIdempotencyCleanupTimer();
  try {
    const queueName = `printserver-${clientId}`;
    console.log(`🔧 Registering client: ${clientId}`);

    // Check if queue already exists
    let queueUrl;
    try {
      queueUrl = await getQueueUrl(queueName, { context: tempClients });
      console.log(`📋 Queue already exists: ${queueName}`);
    } catch (error) {
      console.log(`📋 Creating queue: ${queueName}`);
      await getSqsClient(tempClients).send(new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          VisibilityTimeout: '300',
          MessageRetentionPeriod: '604800',
          ReceiveMessageWaitTimeSeconds: '20',
        }
      }));
      await new Promise(resolve => setTimeout(resolve, 2000));
      queueUrl = await getQueueUrl(queueName, { context: tempClients });
    }

    const urlParts = queueUrl.split('/');
    const accountId = urlParts[urlParts.length - 2];
    const queueRegion = getRegionFromQueueUrl(queueUrl) || await resolveRegionFromClient(getSqsClient(tempClients));
    const queueArn = `arn:aws:sqs:${queueRegion}:${accountId}:${queueName}`;

    await getSqsClient(tempClients).send(new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 's3.amazonaws.com' },
              Action: 'sqs:SendMessage',
              Resource: queueArn,
              Condition: {
                ArnEquals: { 'aws:SourceArn': `arn:aws:s3:::${await getResolvedBucketName(tempClients)}` }
              }
            }
          ]
        })
      }
    }));

    await new Promise(resolve => setTimeout(resolve, 1000));

    const currentNotifications = await getS3Client(tempClients).send(new GetBucketNotificationConfigurationCommand({
      Bucket: await getResolvedBucketName(tempClients)
    }));

    const existingNotification = (currentNotifications.QueueConfigurations || []).find(
      config => config.Id === `PrintServer-${clientId}`
    );

    if (!existingNotification) {
      const updatedNotifications = {
        ...currentNotifications,
        QueueConfigurations: [
          ...(currentNotifications.QueueConfigurations || []),
          {
            Id: `PrintServer-${clientId}`,
            QueueArn: queueArn,
            Events: ['s3:ObjectCreated:*'],
            Filter: {
              Key: {
                FilterRules: [{ Name: 'prefix', Value: `clients/${clientId}/` }]
              }
            }
          }
        ]
      };

      await getS3Client(tempClients).send(new PutBucketNotificationConfigurationCommand({
        Bucket: await getResolvedBucketName(tempClients),
        NotificationConfiguration: updatedNotifications
      }));
      console.log(`✅ S3 notification configured for ${clientId}`);
    } else {
      console.log(`⚠️  S3 notification already exists for ${clientId}, skipping...`);
    }

    console.log(`✅ Client registered successfully: ${clientId}`);
    console.log(`🎯 Queue: ${queueName}`);
    console.log(`📁 S3 prefix: clients/${clientId}/`);

  } catch (error) {
    console.error('❌ Registration failed:', error.message);
    console.error('💡 This might be due to:');
    console.error('   - AWS permissions issues');
    console.error('   - Queue creation delays');
    console.error('   - S3 notification conflicts');
    console.error('   - Try again in a few moments');
  } finally {
    if (!sharedSqsClient && !sharedS3Client && !sharedStsClient) {
      destroyTemporaryAwsClients(tempClients);
    }
    if (hadTimerRunning) startIdempotencyCleanupTimer();
  }
}

async function unregisterClient(clientId) {
  const tempClients = sharedSqsClient || sharedS3Client || sharedStsClient
    ? { sqsClient: sharedSqsClient, s3Client: sharedS3Client, stsClient: sharedStsClient }
    : createTemporaryAwsClients({ sqs: true, s3: true, sts: true });
  const hadTimerRunning = Boolean(idempotencyCleanupHandle);
  if (hadTimerRunning) stopIdempotencyCleanupTimer();
  try {
    console.log(`🔧 Unregistering client: ${clientId}`);

    const currentNotifications = await getS3Client(tempClients).send(new GetBucketNotificationConfigurationCommand({
      Bucket: await getResolvedBucketName(tempClients)
    }));

    const updatedNotifications = {
      ...currentNotifications,
      QueueConfigurations: (currentNotifications.QueueConfigurations || []).filter(config =>
        config.Id !== `PrintServer-${clientId}`
      )
    };

    const removedCount = (currentNotifications.QueueConfigurations || []).length - (updatedNotifications.QueueConfigurations || []).length;

    if (removedCount > 0) {
      console.log(`📡 Removing S3 notification for ${clientId}...`);
      await getS3Client(tempClients).send(new PutBucketNotificationConfigurationCommand({
        Bucket: await getResolvedBucketName(tempClients),
        NotificationConfiguration: updatedNotifications
      }));
      console.log(`✅ Removed ${removedCount} S3 notification(s)`);
    } else {
      console.log(`⚠️  No S3 notification found for ${clientId}`);
    }

    try {
      const queueName = `printserver-${clientId}`;
      console.log(`🗑️  Deleting queue: ${queueName}`);
      const queueUrl = await getQueueUrl(queueName, { context: tempClients });
      await getSqsClient(tempClients).send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      console.log(`✅ Queue deleted: ${queueName}`);
    } catch (queueError) {
      if (queueError.name === 'QueueDoesNotExist') {
        console.log(`⚠️  Queue printserver-${clientId} does not exist (already deleted)`);
      } else {
        console.log(`⚠️  Could not delete queue: ${queueError.message}`);
      }
    }

    console.log(`✅ Client unregistered successfully: ${clientId}`);

  } catch (error) {
    console.error('❌ Unregistration failed:', error.message);
    console.error('💡 This might be due to:');
    console.error('   - AWS permissions issues');
    console.error('   - Resource already deleted');
    console.error('   - Try checking AWS console manually');
  } finally {
    if (!sharedSqsClient && !sharedS3Client && !sharedStsClient) {
      destroyTemporaryAwsClients(tempClients);
    }
    if (hadTimerRunning) startIdempotencyCleanupTimer();
  }
}

// Temporary directory for downloaded files
const TMP_DIR = path.join(__dirname, 'tmp');


async function main() {
  // Check if we're in quick print mode (positional arguments provided)
  const args = process.argv.slice(2);
  const hasPositionalArgs = args.length > 0 && !args[0].startsWith('-');

  // Check for registration command
  if (args.length >= 2 && args[0] === 'register') {
    const clientId = args[1];
    await registerClient(clientId);
    return;
  }

  // Check for unregistration command
  if (args.length >= 2 && args[0] === 'unregister') {
    const clientId = args[1];
    await unregisterClient(clientId);
    return;
  }

  if (hasPositionalArgs) {
    // Quick print mode: upload file and exit
    if (args.length < 3) {
      console.log('Quick Print Mode:');
      console.log('Usage: node client <filePath> <clientId> <printerId> [printOptions]');
      console.log('Examples:');
      console.log('  node client test-files/product-label.pdf test-store "192.168.7.101/socket" "-o media=Custom.62x50mm"');
      console.log('  node client test-files/product-label.pdf test-store 192.168.7.101 "-o media=Custom.62x50mm"  # defaults to IPP');
      console.log('  node client test-files/product-label.pdf test-store Brother_MFC_L3770CDW_series  # direct printer name');
      console.log('');
      console.log('Client Management:');
      console.log('  node client register <clientId>');
      console.log('  node client unregister <clientId>');
      console.log('');
      console.log('Print Client Mode:');
      console.log('Usage: node client');
      console.log('Starts the print client to listen for print jobs');
      process.exit(1);
    }

    const [filePath, clientId, printerId, printOptions] = args;

    console.log(`📤 Quick Print: ${filePath}`);
    console.log(`🏪 Client: ${clientId}`);
    console.log(`🖨️  Printer: ${printerId}`);
    if (printOptions) {
      console.log(`⚙️  Options: ${printOptions}`);
    }

    try {
      const result = await uploadPrintJob(filePath, clientId, printerId, printOptions || '');
      if (result.success) {
        console.log('✅ Print job uploaded successfully!');
        console.log(`📄 S3 Key: ${result.key}`);
      } else {
        console.error('❌ Upload failed:', result.error);
      }
    } catch (error) {
      console.error('❌ Upload error:', error.message);
    }
    return; // Unreachable because of process.exit, kept for clarity
  }

  // Normal polling mode
  console.log(`🚀 Print Client: ${CLIENT_ID} (${TEST_MODE ? 'TEST' : 'LIVE'})`);

  // Ensure temp directory exists
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }

  try {
    // Use client-specific queue: printserver-{clientId}
    const queueName = `printserver-${CLIENT_ID}`;
    const queueUrl = await getQueueUrl(queueName);
    console.log(`📡 Queue: ${queueName}`);

    startIdempotencyCleanupTimer();

    // Process any messages available at startup
    await drainVisibleMessages(queueUrl);
    const initialStatus = await checkQueueStatus(queueUrl);

    if (initialStatus?.notVisible > 0) {
      console.log(`⏳ ${initialStatus.notVisible} in-flight`);
    }

    console.log(`✅ Ready`);

    // Main processing loop
    let connectionLost = false;
    while (!isShuttingDown) {
      try {
        const messages = await receiveMessages(queueUrl);

        if (connectionLost && messages.length > 0) {
          console.log('🔗 Connected');
          connectionLost = false;
        }

        if (messages.length === 0) continue;

        if (isShuttingDown) break;

        // Process all messages in parallel for better throughput
        const results = await Promise.allSettled(
          messages.map(message => processMessage(message, queueUrl))
        );
        
        // Log any failures for debugging
        results.forEach((result, idx) => {
          if (result.status === 'rejected') {
            console.error(`❌ Message ${idx + 1} processing failed:`, result.reason);
          }
        });

      } catch (error) {
        if (isShuttingDown) break;

        const isNetworkError = ['ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH', 'ETIMEDOUT'].includes(error.code);

        if (isNetworkError) {
          if (!connectionLost) {
            console.log('📶 Connection lost');
            connectionLost = true;
          }
          await sleep(10000);
        } else {
          console.error('❌ Error:', error.message);
          await sleep(5000);
        }
      }
    }

    if (isShuttingDown) {
      console.log('🏁 Print client shutdown complete');
    }

  } catch (error) {
    console.error('💥 Failed to start client:', error.message);
  }
}

async function getQueueUrl(queueName, options = { createIfMissing: true, context: {} }) {
  try {
    const command = new GetQueueUrlCommand({
      QueueName: queueName
    });

    const response = await getSqsClient(options.context).send(command);
    return response.QueueUrl;
  } catch (error) {
    if (error.name === 'QueueDoesNotExist' && options.createIfMissing) {
      console.log(`Queue '${queueName}' does not exist. Creating it now...`);
      try {
        const createQueueCommand = new CreateQueueCommand({
          QueueName: queueName,
          Attributes: {
            VisibilityTimeout: '300', // 5 minutes
            MessageRetentionPeriod: '604800', // 7 days
            ReceiveMessageWaitTimeSeconds: '20', // Long polling
          }
        });

        const response = await getSqsClient(options.context).send(createQueueCommand);
        console.log(`✅ Created queue: ${queueName}`);
        return response.QueueUrl;
      } catch (createError) {
        throw new Error(`Failed to create queue '${queueName}': ${createError.message}`);
      }
    } else {
      throw error;
    }
  }
}

async function checkQueueStatus(queueUrl) {
  try {
    const response = await getSqsClient().send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible']
    }));

    const visible = parseInt(response.Attributes.ApproximateNumberOfMessages);
    const notVisible = parseInt(response.Attributes.ApproximateNumberOfMessagesNotVisible);

    return { visible, notVisible };
  } catch (error) {
    return null;
  }
}

async function receiveMessages(queueUrl) {
  const command = new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 20,
    VisibilityTimeout: 300,
    AttributeNames: ['ApproximateReceiveCount', 'SentTimestamp']
  });

  const response = await getSqsClient().send(command);
  const messages = response.Messages || [];

  return messages;
}

// Process any messages immediately available at startup
async function drainVisibleMessages(queueUrl) {
  let totalProcessed = 0;

  while (true) {
    const response = await getSqsClient().send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 300,
      AttributeNames: ['ApproximateReceiveCount', 'SentTimestamp']
    }));

    const messages = response.Messages || [];
    if (messages.length === 0) break;

    // Process startup messages in parallel too
    await Promise.allSettled(
      messages.map(message => processMessage(message, queueUrl))
    );
    totalProcessed += messages.length;
  }

  if (totalProcessed > 0) {
    console.log(`⚡ Processed ${totalProcessed} startup`);
  }
}

// Parse SQS message and extract S3 details
function parseSqsMessage(message) {
  const parsed = JSON.parse(message.Body);

  if (parsed.Records && parsed.Records[0]) {
    // S3 notification format
    const record = parsed.Records[0];
    return {
      bucket: record.s3.bucket.name,
      key: decodeURIComponent(record.s3.object.key),
      isValid: true
    };
  }

  return { isValid: false };
}

// Fetch S3 metadata and download file (single GetObject)
async function fetchS3DataAndDownload(bucket, key) {
  const filename = path.basename(key);
  const localFilePath = path.join(TMP_DIR, filename);
  const getResponse = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));

  // Extract metadata
  const printerId = getResponse.Metadata?.['printer'] || 'unknown';
  const printOptions = getResponse.Metadata?.['print-options'] || '';

  // Download file to disk
  const stream = getResponse.Body;
  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(localFilePath);
    stream.pipe(fileStream);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });

  return { localFilePath, printerId, printOptions };
}

async function processMessage(message, queueUrl) {
  let localFilePath = null;
  const messageId = message.MessageId?.substring(0, 8) || 'unknown';
  const receiveCount = parseInt(message.Attributes?.ApproximateReceiveCount || '1');

  try {
    activeProcessingCount++;
    
    // Log receive count to detect reprocessing
    if (receiveCount > 1) {
      console.log(`[${messageId}] 📥 Processing message (${activeProcessingCount} active) ⚠️  RECEIVE COUNT: ${receiveCount}`);
    } else {
      console.log(`[${messageId}] 📥 Processing message (${activeProcessingCount} active)`);
    }

    if (isShuttingDown) {
      console.log(`[${messageId}] ⏹️  Shutdown requested, skipping message`);
      return;
    }

    // Parse SQS message
    const s3Data = parseSqsMessage(message);
    if (!s3Data.isValid) {
      console.warn(`[${messageId}] ⚠️  Skipping message with unknown format`);
      // Delete invalid messages to prevent infinite retries
      await deleteMessage(queueUrl, message.ReceiptHandle);
      return;
    }

    console.log(`[${messageId}] 📄 File: ${s3Data.key.split('/').pop()}`);

    // Filter messages for this CLIENT_ID
    if (!s3Data.key.startsWith(`clients/${CLIENT_ID}/`)) {
      console.log(`[${messageId}] ⏭️  Skipping message for different client: ${s3Data.key}`);
      // Delete messages for other clients to prevent accumulation
      await deleteMessage(queueUrl, message.ReceiptHandle);
      return;
    }

    // IDEMPOTENCY CHECK: Skip if already processed recently
    if (processedKeys.has(s3Data.key)) {
      const processedTime = processedKeys.get(s3Data.key);
      const ageMinutes = Math.floor((Date.now() - processedTime) / 60000);
      console.log(`[${messageId}] 🔄 DUPLICATE DETECTED - Already processed ${ageMinutes} min ago`);
      console.log(`[${messageId}] ⏭️  Skipping duplicate, deleting message`);
      await deleteMessage(queueUrl, message.ReceiptHandle);
      return;
    }

    // Fetch metadata and download file in parallel
    console.log(`[${messageId}] ⬇️  Downloading...`);
    const { localFilePath: filePath, printerId, printOptions } = await fetchS3DataAndDownload(s3Data.bucket, s3Data.key);
    localFilePath = filePath;

    if (isShuttingDown) return;

    // Print the file
    console.log(`[${messageId}] 🖨️  Printing to ${printerId}...`);
    await printFile(printerId, localFilePath, printOptions);

    // Mark as processed BEFORE deleting message (idempotency)
    processedKeys.set(s3Data.key, Date.now());
    console.log(`[${messageId}] 💾 Marked as processed (cache size: ${processedKeys.size})`);

    // Success - delete message from queue
    await deleteMessage(queueUrl, message.ReceiptHandle);

    console.log(`[${messageId}] ✅ Printed: ${printerId}`);

  } catch (error) {
    console.error(`[${messageId}] ❌ Error processing message:`, error.message);
    console.error(`[${messageId}] Stack:`, error.stack);
    console.log(`[${messageId}] 🔄 Message will be retried after visibility timeout`);
  } finally {
    // Clean up temp file
    if (localFilePath && fs.existsSync(localFilePath)) {
      try {
        fs.unlinkSync(localFilePath);
        console.log(`[${messageId}] 🧹 Cleaned up temporary file`);
      } catch (cleanupError) {
        console.warn(`[${messageId}] ⚠️  Failed to clean up temp file:`, cleanupError.message);
      }
    }

    activeProcessingCount--;
    console.log(`[${messageId}] 🏁 Done (${activeProcessingCount} active)`);

    if (isShuttingDown && activeProcessingCount === 0) {
      console.log('🏁 All messages processed, shutting down...');
      process.exit(0);
    }
  }
}

async function printFile(printerId, filePath, printOptions) {
  if (!printerId) {
    console.log("No printer specified");
    return false;
  }

  if (!fs.existsSync(filePath)) {
    console.log("File does not exist:", filePath);
    return false;
  }

  // Check if this is an IP-based printer ID
  let localPrinterName;
  let printerIp = null;
  let protocol = null;

  // Check for explicit format: ip/protocol (e.g., "192.168.6.29/socket")
  if (printerId.includes('/')) {
    const slashParts = printerId.split('/');
    if (slashParts.length === 2) {
      printerIp = slashParts[0];
      protocol = slashParts[1];
    }
  } else {
    // No protocol specified - check if it's an IP address and default to IPP
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipRegex.test(printerId)) {
      printerIp = printerId;
      protocol = 'ipp'; // Default to IPP protocol
    }
  }

  if (printerIp && protocol) {
    // IP-based printer ID (normalized from either format)
    console.log(`Printing on ${printerIp} (${protocol})`);

    // Check if printer is registered, register if not
    if (!(await isPrinterRegistered(printerIp))) {
      await registerNewPrinter(printerIp, protocol);
    }

    localPrinterName = getLocalPrinterName(printerIp);
  } else {
    // Direct printer name (like Brother_MFC_L3770CDW_series)
    console.log(`Printing on ${printerId} (direct printer name)`);
    localPrinterName = printerId;

    // Check if this direct printer name exists
    if (!(await isPrinterRegisteredByName(printerId))) {
      console.log(`Warning: Printer '${printerId}' not found in system`);
      console.log(`Make sure the printer '${printerId}' is properly configured`);
    }
  }
  const command = `lp -d ${localPrinterName} "${filePath}" ${printOptions}`.trim();

  if (TEST_MODE) {
    console.log(`TEST MODE: Would execute: ${command}`);
    return true;
  }

  try {
    console.log(`Executing: ${command}`);
    const { stdout, stderr } = await execPromise(command);
    if (stdout) console.log('Print stdout:', stdout);
    if (stderr) console.log('Print stderr:', stderr);
    return true;
  } catch (error) {
    console.log(`Error while printing: ${error.message}`);
    return false;
  }
}

async function isPrinterRegistered(ip) {
  try {
    const { stdout } = await execPromise(`lpstat -p -d`);
    const localPrinterName = getLocalPrinterName(ip);
    if (stdout.includes(localPrinterName)) {
      return true;
    } else {
      console.log(`${ip} is not registered as a printer`);
      return false;
    }
  } catch (error) {
    console.log('Error checking printer registration:', error);
    return false;
  }
}

async function isPrinterRegisteredByName(printerName) {
  try {
    const { stdout } = await execPromise(`lpstat -p -d`);
    if (stdout.includes(printerName)) {
      return true;
    } else {
      console.log(`Printer '${printerName}' is not registered in the system`);
      return false;
    }
  } catch (error) {
    console.log('Error checking printer registration by name:', error);
    return false;
  }
}

async function registerNewPrinter(ip, protocol) {
  console.log(`Registering ${ip} as a printer`);
  const localPrinterName = getLocalPrinterName(ip);

  try {
    let command;
    const ppdPath = getPPDPathForPrinter(ip, protocol);

    if (protocol === "socket") {
      // Use PPD file if available
      if (ppdPath) {
        command = `lpadmin -p ${localPrinterName} -E -v "socket://${ip}/" -P "${ppdPath}"`;
      } else {
        // Fallback to everywhere if no PPD found
        console.log(`Using generic 'everywhere' driver`);
        command = `lpadmin -p ${localPrinterName} -E -v "socket://${ip}/" -m everywhere`;
      }
    } else if (protocol === "lpd") {
      // Use PPD file if available
      if (ppdPath) {
        command = `lpadmin -p ${localPrinterName} -E -v "lpd://${ip}" -P "${ppdPath}"`;
      } else {
        // Fallback to everywhere if no PPD found
        console.log(`Using generic 'everywhere' driver`);
        command = `lpadmin -p ${localPrinterName} -E -v "lpd://${ip}" -m everywhere`;
      }
    } else if (protocol === "ipp") {
      command = `lpadmin -p ${localPrinterName} -E -v "ipp://${ip}/ipp/print" -m everywhere`;
    } else {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    if (TEST_MODE) {
      console.log(`TEST MODE: Would execute: ${command}`);
      return true;
    }

    console.log(`Executing: ${command}`);
    await execPromise(command);

    // Wait for printer to be ready
    await sleep(5000);
    return true;

  } catch (error) {
    console.log(`Error registering printer: ${error.message}`);
    return false;
  }
}

function getLocalPrinterName(printerIp) {
  return "_" + printerIp.replace(/\./g, "_");
}

function getPPDPathForPrinter(ip, protocol) {
  // For Brother MFC printers (like MFC-L3770CDW), don't use PPD files
  // Use IPP protocol or "everywhere" driver instead for better compatibility
  if (protocol === 'ipp') {
    console.log(`Using IPP protocol for Brother MFC printer - no PPD needed`);
    return null; // Use IPP without PPD
  }

  // For LPD protocol, prioritize ZebraPrinterPPD over Brother PPD files
  if (protocol === 'lpd') {
    const zebraPPDPath = path.join(__dirname, 'ZebraPrinterPPD');
    if (fs.existsSync(zebraPPDPath)) {
      console.log(`Using Zebra PPD file for LPD printer: ${zebraPPDPath}`);
      return zebraPPDPath;
    }
  }

  // Check for compressed PPD files - for socket protocol
  const compressedPPDPath = path.join(__dirname, 'BrotherQL820NwbCupsPpd.gz');
  if (fs.existsSync(compressedPPDPath)) {
    console.log(`Using compressed Brother PPD file: ${compressedPPDPath}`);
    return compressedPPDPath;
  }

  // Check for uncompressed PPD files
  const uncompressedPPDPath = path.join(__dirname, 'brother_ql820nwb_printer_en.ppd');
  if (fs.existsSync(uncompressedPPDPath)) {
    console.log(`Using uncompressed Brother PPD file: ${uncompressedPPDPath}`);
    return uncompressedPPDPath;
  }

  // Check for other PPD files (fallback for LPD if ZebraPrinterPPD wasn't found)
  const ppdFiles = [
    'ZebraPrinterPPD'
  ];

  for (const ppdFile of ppdFiles) {
    const ppdPath = path.join(__dirname, ppdFile);
    if (fs.existsSync(ppdPath)) {
      console.log(`Using PPD file: ${ppdPath}`);
      return ppdPath;
    }
  }

  console.log(`No specific PPD files found - will use generic driver`);
  return null; // Use generic "everywhere" driver
}

async function deleteMessage(queueUrl, receiptHandle) {
  const command = new DeleteMessageCommand({
    QueueUrl: queueUrl,
    ReceiptHandle: receiptHandle,
  });

  await getSqsClient().send(command);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Export functions for testing
module.exports = {
  uploadPrintJob,
  getResolvedBucketName,
  registerClient,
  unregisterClient
};

// Start the client
main().catch(console.error);
