# AWS Serverless Print Server

This is a serverless solution for printing documents from web applications. Perfect for logistics needs, such as printing order documents or shipping labels in a warehouse from a web UI.

You just upload a file to your S3 bucket and it will be printed within a split-second on any printer in the local network where the client is running.

The serverless architecture makes it scalable and hosting costs (your AWS bill) are basically free for any reasonable amount of usage. This makes it the perfect replacement for paid services such as [PrintNode](https://printnode.com).

## How It Works

After a file is uploaded to the S3 bucket, an instant notification is sent to the client's SQS queue. The client then downloads the file and prints it to the printer.

The local client uses CUPS to discover, register and print to printers in the local network.

## Prerequisites

- Node.js 16+
- CUPS printing system (comes pre-installed on macOS, available on Linux and Windows with WSL)
- AWS CLI configured with appropriate credentials

Some printer features such as variable label lengths with automatic cutting on the Brother QL-820NWBc are dependent on the operating systems's printer drivers and only proved to work reliably on macOS.

## Getting Started

### 1) Deploy infrastructure

```bash
cd cdk
npm install
npm run deploy

# Optional: set custom S3 file retention (default 720 hours = 30 days)
cdk deploy --context fileRetentionHours=168
```

After deployment, note the CloudFormation output `PrintBucketName` (bucket name is `printserver-<account>-<region>`).

### 2) Install the client

```bash
cd client
npm install
```

### 3) Configure environment

Create `client/.env` (or a `.env` in the repo root). The client loads either automatically.

```bash
# Authentication (use either access keys or a named profile)
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AWS_PROFILE=default
AWS_REGION=eu-central-1

# Required: bucket name from the CDK output
S3_BUCKET_NAME=printserver-123456789012-eu-central-1

# Your client identifier (used for per-client SQS queue and S3 prefix)
CLIENT_ID=warehouse1

# Optional: test mode logs the print command instead of printing
# TEST_MODE=true
```

### 4) Register the client (one-time)

This creates the SQS queue `printserver-<clientId>` and configures S3 notifications for `clients/<clientId>/`. Requires AWS permissions to create queues and update bucket notifications.

```bash
# from repo root
node client register warehouse1
```

### 5) Start the print client

```bash
# from repo root
node client

# Test mode (no actual printing)
TEST_MODE=true node client
```

### 6) Quick print from the CLI (optional)

Uploads a file to S3 with the right metadata; the running client then prints it.

```bash
# Basic
node client test-files/product-label.pdf warehouse1 Brother_MFC_L3770CDW_series

# With options
node client invoice.pdf warehouse1 192.168.1.100 "-o media=A4 -o copies=2"

# More examples
node client product-label.pdf warehouse1 "192.168.7.101/socket" "-o media=Custom.62x50mm"
node client invoice.pdf store1 192.168.1.100 "-o media=A4"               # defaults to IPP
node client label.pdf office Brother_MFC_L3770CDW_series "-o media=Letter" # direct printer name
```

### Client management

```bash
# Register a new client
node client register your-client-name

# Unregister a client (removes queue and S3 notifications)
node client unregister your-client-name
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

## AWS Setup

### Minimal IAM policy for running the client

Allows the client to receive jobs from its SQS queue and download files from S3. Scope resources to your account/region as needed.

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
        "sqs:GetQueueUrl"
      ],
      "Resource": "arn:aws:sqs:*:*:printserver-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::printserver-*/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::printserver-*"
      ]
    }
  ]
}
```

### Additional permissions for registration (one-time setup)

Required only when running `node client register <clientId>` or `unregister`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:CreateQueue",
        "sqs:SetQueueAttributes",
        "sqs:DeleteQueue"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketNotificationConfiguration",
        "s3:PutBucketNotificationConfiguration"
      ],
      "Resource": "arn:aws:s3:::printserver-*"
    }
  ]
}
```

### Minimal IAM policy for web applications (upload-only)

Web apps that submit print jobs only need permission to upload objects into the client’s prefix in the print bucket.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::printserver-*"
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
