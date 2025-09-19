# AWS Serverless Print Server

This is a serverless solution for printing documents from web applications. Perfect for logistics needs, such as printing order documents or shipping labels in a warehouse from a web UI.

You just upload a file to your S3 bucket and it will be printed within a split-second on any printer in the local network where the client is running.

The serverless architecture makes it scalable and hosting costs (your AWS bill) are basically free for any reasonable amount of usage. This makes it the perfect replacement for paid services such as [PrintNode](https://printnode.com).

## How It Works

After a files is uploaded to the S3 bucket, an instant notification is sent to the client's SQS queue. The client then downloads the file and prints it to the printer.

The local client uses CUPS to discover, register and print to printers in the local network.

## Prerequisites

- Node.js 16+
- CUPS printing system (comes pre-installed on macOS, available on Linux and Windows with WSL)
- AWS CLI configured with appropriate credentials

Some printer features such as variable label lengths with automatic cutting on the Brother QL-820NWBc are dependent on the operating systems's printer drivers and only proved to work reliably on macOS.

## Quick Start

### 1. Deploy Infrastructure

```bash
# Install CDK dependencies and deploy
cd cdk
npm install
cdk deploy

# Or deploy with custom file retention (default: 30 days = 720 hours)
cdk deploy --context fileRetentionHours=168  # 7 days
```

### 2. Register Your Client

Each local client needs to be registered to create their dedicated queue. One client can serve many printers (the actual printer queue is managed by CUPS):

```bash
# Register your client (requires AWS credentials with S3/SQS permissions)
node client register your-store-name

# This creates:
# - SQS queue: printserver-your-store-name
# - S3 notifications for: clients/your-store-name/
```

### 3. Install Client Dependencies

```bash
# Install Node.js dependencies
cd client
npm install
```

### 4. Configure Client Environment

Create a `.env` file in the client directory:

**.env file:**
```bash
# AWS credentials (minimal SQS-only permissions recommended)
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=eu-central-1

# Your client identifier (must match registration)
CLIENT_ID=your-store-name

# Optional: Enable test mode (logs what would be printed instead of printing)
# TEST_MODE=true
```

### 5. Start the Print Client

```bash
# Start processing print jobs (from client directory)
cd client
node index.js

# Or run in test mode (logs what would be printed)
TEST_MODE=true node index.js
```

## Usage

### Command Line Upload

Upload files directly from your application or command line:

```bash
# Basic upload and print (from root directory)
node client your-file.pdf your-client printer-name

# With print options
node client invoice.pdf store1 192.168.1.100 "-o media=A4 -o copies=2"

# Examples
node client product-label.pdf warehouse "192.168.7.101/socket" "-o media=Custom.62x50mm"
node client invoice.pdf store1 192.168.1.100 "-o media=A4"                    # defaults to IPP
node client label.pdf office Brother_MFC_L3770CDW_series "-o media=Letter"    # direct printer name
```

### Client Management

```bash
# Register a new client
node client register your-client-name

# Unregister a client (removes queue and S3 notifications)
node client unregister your-client-name
```

### Client Operation

```bash
# Start the print client (from client directory or use full path)
cd client && node index.js
# or from root:
node client/index.js

# Run in test mode (logs what would be printed without actually printing)
TEST_MODE=true node client/index.js

# Clear all messages in queue (⚠️ WARNING: will lose pending prints!)
node client/index.js --clear-queue

# Monitor queue status in real-time
node client/index.js --monitor

# Wait for in-flight messages to become visible
node client/index.js --wait
```

### Web Application Integration

Integrate printing into your web application by uploading files to the S3 bucket with the correct metadata.

#### Node.js Backend Example

```javascript
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({ region: 'eu-central-1' });

async function printDocument(fileBuffer, filename, clientId, printerId, printOptions = '') {
  const key = `clients/${clientId}/${filename}`;

  // Set printer metadata
  const metadata = {
    'printer': printerId,           // e.g., "192.168.1.100" or "192.168.1.100/socket"
    'print-options': printOptions   // e.g., "-o media=A4 -o copies=2"
  };

  const command = new PutObjectCommand({
    Bucket: 'your-printserver-bucket',
    Key: key,
    Body: fileBuffer,
    Metadata: metadata,
    ContentType: 'application/pdf'
  });

  try {
    await s3Client.send(command);
    return { success: true };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Usage examples
await printDocument(
  pdfBuffer,
  'invoice-123.pdf',
  'store1',                      // client name
  'Brother_MFC_L3770CDW_series'  // printer
);

await printDocument(
  labelBuffer,
  'shipping-label.pdf',
  'warehouse1',             // client name
  '192.168.7.101/socket',   // Label printer with local IP
  '-o media=Custom.62x50mm' // Automatic label cutting after 50mm
);
```

## File Structure & Configuration

### S3 File Structure

Files are stored in S3 with this structure:
```
clients/{clientId}/{filename}
```

**Examples:**
- `clients/store1/invoice.pdf`
- `clients/warehouse/label.pdf`

### Print Options

Print options can be specified as S3 object metadata with the key `print-options`. The value should contain valid CUPS print options:

```json
{
  "print-options": "-o media=A4 -o copies=2 -o sides=two-sided-long-edge"
}
```

**Common print options:**
- `-o media=A4` - Paper size
- `-o copies=2` - Number of copies
- `-o sides=two-sided-long-edge` - Double-sided printing
- `-o media=Custom.62x50mm` - Custom label size (for Brother QL-820NWBc)

### Printer Configuration

#### Printer IDs

**Network Printers:**
- `192.168.1.100/ipp` - Internet Printing Protocol (recommended for most office printers)
- `192.168.1.100/socket` - Raw socket connection (works with Brother label printers like QL-820NWBc)
- `192.168.1.100/lpd` - Line Printer Daemon (works with Zebra shipping label printers)
- `192.168.1.100` - **Defaults to IPP protocol**

**Local Printers:**
- `Brother_MFC_L3770CDW_series` - Direct printer name
- `HP_LaserJet_Pro` - Any CUPS printer name

#### Supported Protocols

- **IPP (Internet Printing Protocol)**: Modern protocol, works with most office printers
- **Socket**: Raw socket connection, reliable for label printers
- **LPD (Line Printer Daemon)**: Traditional protocol, works with shipping label printers
- **Direct printer names**: Use any printer configured in CUPS

### Error Handling

- **Failed print jobs** are logged locally but not retried automatically
- **Printer registration failures** are handled gracefully
- **Network printer issues** are managed by the operating system's print queue
- **S3 upload failures** return error status to the application
- **Queue processing errors** are logged but don't stop the client

## Troubleshooting

### Common Issues

**No messages received:**
- Verify `CLIENT_ID` in `.env` matches the registered client name
- Check AWS credentials have SQS permissions
- Ensure client is registered: `node client register your-client-id`

**Messages stuck as "in-flight":**
- These are from previous interrupted sessions
- Wait 5 minutes for visibility timeout to expire
- Or use `node client/index.js --clear-queue` (⚠️ loses pending prints)

**Client not starting:**
- Check `.env` file exists in client directory
- Verify AWS credentials are correct
- Ensure Node.js dependencies are installed: `cd client && npm install`

**Printer connection issues:**
- Test printer connectivity: `lpstat -p`
- Check printer IP and protocol
- Verify printer is online and accepting connections

### Useful Commands

```bash
# Check queue status
aws sqs get-queue-attributes --queue-url $(aws sqs get-queue-url --queue-name printserver-your-client --query QueueUrl --output text) --attribute-names ApproximateNumberOfMessages

# Monitor client logs
node client/index.js 2>&1 | tee print-client.log

# Test printer connectivity
lpstat -p your-printer-name

# List all printserver queues
aws sqs list-queues --queue-name-prefix printserver-
```

## AWS Setup

### Minimal IAM Policy (Recommended)

Create an IAM user with only the necessary SQS permissions for client applications:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ListQueues"
      ],
      "Resource": "arn:aws:sqs:*:*:printserver-*"
    }
  ]
}
```

### CDK Deployment Permissions

For registering clients and deploying infrastructure, you'll need broader permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:*",
        "sqs:*",
        "iam:*",
        "cloudformation:*"
      ],
      "Resource": "*"
    }
  ]
}
```
