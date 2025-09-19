import { beforeAll } from 'vitest'

// Mock AWS SDK to avoid needing actual AWS credentials in tests
process.env.AWS_REGION = 'us-east-1'
process.env.AWS_ACCESS_KEY_ID = 'test-key-id'
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key'

// Mock environment variables for tests
process.env.S3_BUCKET_NAME = 'test-print-bucket'
process.env.CLIENT_ID = 'test-client'

// Global test setup
beforeAll(() => {
  console.log('🧪 Setting up test environment...')
})
