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

// Upload print job function
async function uploadPrintJob(filePath, clientId, printerId, printOptions = '') {
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
    const bucketName = await getResolvedBucketName();
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileContent,
      Metadata: metadata
    });

    await s3Client.send(command);

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

// AWS Clients
const sqsClient = new SQSClient();
const s3Client = new S3Client();
const stsClient = new STSClient();

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

async function getAccountId() {
  const res = await stsClient.send(new GetCallerIdentityCommand({}));
  return res.Account;
}

async function getResolvedBucketName() {
  if (S3_BUCKET_NAME) return S3_BUCKET_NAME;
  if (resolvedBucketNameCache) return resolvedBucketNameCache;
  const [accountId, region] = await Promise.all([
    getAccountId(),
    resolveRegionFromClient(s3Client)
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
  try {
    const queueName = `printserver-${clientId}`;
    console.log(`🔧 Registering client: ${clientId}`);

    // Check if queue already exists
    let queueUrl;
    try {
      queueUrl = await getQueueUrl(queueName);
      console.log(`📋 Queue already exists: ${queueName}`);
    } catch (error) {
      // Queue doesn't exist, create it
      console.log(`📋 Creating queue: ${queueName}`);
      await sqsClient.send(new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          VisibilityTimeout: '300',
          MessageRetentionPeriod: '604800',
          ReceiveMessageWaitTimeSeconds: '20',
        }
      }));

      // Wait a moment for the queue to be fully created
      await new Promise(resolve => setTimeout(resolve, 2000));

      queueUrl = await getQueueUrl(queueName);
    }

    // Get the queue ARN for S3 notifications
    const urlParts = queueUrl.split('/');
    const accountId = urlParts[urlParts.length - 2];
    const queueRegion = getRegionFromQueueUrl(queueUrl) || await resolveRegionFromClient(sqsClient);
    const queueArn = `arn:aws:sqs:${queueRegion}:${accountId}:${queueName}`;
    console.log(`🔗 Queue ARN: ${queueArn}`);

    // Set queue policy to allow S3 to send messages
    console.log(`🔐 Setting queue policy...`);
    await sqsClient.send(new SetQueueAttributesCommand({
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
                ArnEquals: { 'aws:SourceArn': `arn:aws:s3:::${await getResolvedBucketName()}` }
              }
            }
          ]
        })
      }
    }));

    // Wait a moment for the policy to propagate
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Configure S3 bucket notifications
    console.log(`📡 Configuring S3 bucket notifications...`);
    const currentNotifications = await s3Client.send(new GetBucketNotificationConfigurationCommand({
      Bucket: await getResolvedBucketName()
    }));

    // Check if notification already exists
    const existingNotification = (currentNotifications.QueueConfigurations || []).find(
      config => config.Id === `PrintServer-${clientId}`
    );

    if (existingNotification) {
      console.log(`⚠️  S3 notification already exists for ${clientId}, skipping...`);
    } else {
      const newNotification = {
        Id: `PrintServer-${clientId}`,
        QueueArn: queueArn,
        Events: ['s3:ObjectCreated:*'],
        Filter: {
          Key: {
            FilterRules: [{
              Name: 'prefix',
              Value: `clients/${clientId}/`
            }]
          }
        }
      };

      const updatedNotifications = {
        ...currentNotifications,
        QueueConfigurations: [
          ...(currentNotifications.QueueConfigurations || []),
          newNotification
        ]
      };

      await s3Client.send(new PutBucketNotificationConfigurationCommand({
        Bucket: await getResolvedBucketName(),
        NotificationConfiguration: updatedNotifications
      }));

      console.log(`✅ S3 notification configured for ${clientId}`);
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
    process.exit(1);
  }
}

// Unregister client function
async function unregisterClient(clientId) {
  try {
    console.log(`🔧 Unregistering client: ${clientId}`);

    // Get current bucket notifications
    const currentNotifications = await s3Client.send(new GetBucketNotificationConfigurationCommand({
      Bucket: await getResolvedBucketName()
    }));

    // Remove the notification for this client
    const updatedNotifications = {
      ...currentNotifications,
      QueueConfigurations: (currentNotifications.QueueConfigurations || []).filter(config =>
        config.Id !== `PrintServer-${clientId}`
      )
    };

    const removedCount = (currentNotifications.QueueConfigurations || []).length - (updatedNotifications.QueueConfigurations || []).length;

    if (removedCount > 0) {
      console.log(`📡 Removing S3 notification for ${clientId}...`);
      await s3Client.send(new PutBucketNotificationConfigurationCommand({
        Bucket: await getResolvedBucketName(),
        NotificationConfiguration: updatedNotifications
      }));
      console.log(`✅ Removed ${removedCount} S3 notification(s)`);
    } else {
      console.log(`⚠️  No S3 notification found for ${clientId}`);
    }

    // Delete the queue
    try {
      const queueName = `printserver-${clientId}`;
      console.log(`🗑️  Deleting queue: ${queueName}`);
      const queueUrl = await getQueueUrl(queueName);
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      console.log(`✅ Queue deleted: ${queueName}`);
    } catch (queueError) {
      if (queueError.name === 'QueueDoesNotExist') {
        console.log(`⚠️  Queue ${queueName} does not exist (already deleted)`);
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
    process.exit(1);
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
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Upload error:', error.message);
      process.exit(1);
    }
    return;
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
    process.exit(1);
  }
}

async function getQueueUrl(queueName) {
  try {
    const command = new GetQueueUrlCommand({
      QueueName: queueName
    });

    const response = await sqsClient.send(command);
    return response.QueueUrl;
  } catch (error) {
    if (error.name === 'QueueDoesNotExist') {
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

        const response = await sqsClient.send(createQueueCommand);
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
    const response = await sqsClient.send(new GetQueueAttributesCommand({
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
  });

  const response = await sqsClient.send(command);
  const messages = response.Messages || [];

  return messages;
}

// Process any messages immediately available at startup
async function drainVisibleMessages(queueUrl) {
  let totalProcessed = 0;

  while (true) {
    const response = await sqsClient.send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 300,
    }));

    const messages = response.Messages || [];
    if (messages.length === 0) break;

    for (const message of messages) {
      await processMessage(message, queueUrl);
      totalProcessed++;
    }
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
  const getResponse = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

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

  try {
    activeProcessingCount++;
    console.log(`[${messageId}] 📥 Processing message (${activeProcessingCount} active)`);

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

    // Fetch metadata and download file in parallel
    console.log(`[${messageId}] ⬇️  Downloading...`);
    const { localFilePath: filePath, printerId, printOptions } = await fetchS3DataAndDownload(s3Data.bucket, s3Data.key);
    localFilePath = filePath;

    if (isShuttingDown) return;

    // Print the file
    console.log(`[${messageId}] 🖨️  Printing to ${printerId}...`);
    await printFile(printerId, localFilePath, printOptions);

    // Success - delete message from queue
    await deleteMessage(queueUrl, message.ReceiptHandle);

    console.log(`[${messageId}] ✅ Printed: ${printerId}`);

  } catch (error) {
    console.error(`[${messageId}] ❌ Error processing message:`, error.message);
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

  await sqsClient.send(command);
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
