const { uploadPrintJob } = require('./index');

// Test the upload functionality
async function runTest() {
  console.log('Running AWS Print Server Test');

  // Simulate environment variables
  process.env.S3_BUCKET_NAME = 'test-print-bucket';
  process.env.AWS_REGION = 'us-east-1';

  // Create a simple test file
  const fs = require('fs');
  const testContent = 'This is a test print file\nGenerated at: ' + new Date().toISOString();
  fs.writeFileSync('test-print.txt', testContent);

  try {
    // Upload test print job (examples of different printer ID formats)
    console.log('Testing with explicit protocol...');
    const result1 = await uploadPrintJob(
      'test-print.txt',
      'test-client',
      '192.168.1.100/socket',
      '-o media=A4 -o copies=1'
    );

    if (result1.success) {
      console.log('✅ Explicit protocol test successful!');
    }

    console.log('Testing with default IPP protocol...');
    const result2 = await uploadPrintJob(
      'test-print.txt',
      'test-client',
      '192.168.1.100',  // Should default to IPP
      '-o media=A4 -o copies=1'
    );

    const result = result2; // Use the second test for the rest of the logic

    if (result.success) {
      console.log('✅ Test upload successful!');
      console.log('📄 File uploaded to:', result.key);
      console.log('🖨️  Print job will be processed by the client');
    } else {
      console.log('❌ Test upload failed:', result.error);
    }

  } catch (error) {
    console.error('❌ Test error:', error);
  } finally {
    // Clean up test file
    if (fs.existsSync('test-print.txt')) {
      fs.unlinkSync('test-print.txt');
    }
  }
}

// Run test if called directly
if (require.main === module) {
  runTest();
}

module.exports = { runTest };
