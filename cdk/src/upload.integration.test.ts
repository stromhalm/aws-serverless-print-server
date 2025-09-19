import { describe, test, expect, beforeAll, vi } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uploadPrintJob } = require('../../../client/upload-sample.js')

// Mock AWS SDK calls for integration tests
const mockSend = vi.fn()

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockSend
  })),
  PutObjectCommand: vi.fn().mockImplementation((params) => ({
    ...params,
    commandName: 'PutObjectCommand'
  }))
}))

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn().mockImplementation(() => ({
    send: mockSend
  })),
  CreateQueueCommand: vi.fn(),
  GetQueueUrlCommand: vi.fn()
}))

describe('Print Job Upload Integration Tests', () => {
  const testFilePath = join(__dirname, 'shipping-label.pdf')
  const testClientId = 'test-store'
  const testPrinterId = '192.168.1.100/socket'
  const testPrintOptions = '-o media=A4 -o copies=1'

  beforeAll(() => {
    // Verify test file exists
    if (!existsSync(testFilePath)) {
      throw new Error(`Test file not found: ${testFilePath}`)
    }

    // Mock successful S3 upload
    mockSend.mockResolvedValue({
      ETag: '"test-etag"',
      VersionId: 'test-version'
    })
  })

  test('successfully uploads shipping label PDF', async () => {
    const result = await uploadPrintJob(
      testFilePath,
      testClientId,
      testPrinterId,
      testPrintOptions
    )

    expect(result.success).toBe(true)
    expect(result.bucket).toBe(process.env.S3_BUCKET_NAME)
    expect(result.key).toMatch(new RegExp(`^clients/${testClientId}/${testPrinterId}/shipping-label\\.pdf$`))
  })

  test('uploads file with correct metadata', async () => {
    await uploadPrintJob(
      testFilePath,
      testClientId,
      testPrinterId,
      testPrintOptions
    )

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: expect.stringMatching(new RegExp(`clients/${testClientId}/${testPrinterId}/shipping-label\\.pdf`)),
        Metadata: {
          'print-options': testPrintOptions
        },
        ContentType: 'application/pdf'
      })
    )
  })

  test('uploads file without print options', async () => {
    const result = await uploadPrintJob(
      testFilePath,
      testClientId,
      testPrinterId
    )

    expect(result.success).toBe(true)
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        Metadata: undefined // No metadata when no print options
      })
    )
  })

  test('handles different printer protocols', async () => {
    const protocols = ['socket', 'lpd', 'ipp']
    const baseIp = '192.168.1.100'

    for (const protocol of protocols) {
      const printerId = `${baseIp}/${protocol}`
      const result = await uploadPrintJob(
        testFilePath,
        testClientId,
        printerId
      )

      expect(result.success).toBe(true)
      expect(result.key).toContain(printerId)
    }
  })

  test('generates correct S3 key structure', async () => {
    const result = await uploadPrintJob(
      testFilePath,
      testClientId,
      testPrinterId,
      testPrintOptions
    )

    expect(result.key).toMatch(/^clients\/test-store\/shipping-label\.pdf$/)
  })

  test('handles IP addresses without protocol (defaults to IPP)', async () => {
    const ipOnlyPrinterId = '192.168.1.100'

    const result = await uploadPrintJob(
      testFilePath,
      testClientId,
      ipOnlyPrinterId,
      testPrintOptions
    )

    expect(result.success).toBe(true)
    expect(result.key).toMatch(/^clients\/test-store\/shipping-label\.pdf$/)
  })

  test('handles file read errors gracefully', async () => {
    const nonExistentFile = '/path/to/nonexistent/file.pdf'

    const result = await uploadPrintJob(
      nonExistentFile,
      testClientId,
      testPrinterId
    )

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  test('validates printer ID format', async () => {
    // Test valid formats
    const validPrinterIds = [
      '192.168.1.100/socket',
      '10.0.0.50/lpd',
      '172.16.0.1/ipp',
      '192.168.1.100',        // Should default to IPP
      'Brother_MFC_L3770CDW_series'  // Direct printer name
    ]

    for (const printerId of validPrinterIds) {
      const result = await uploadPrintJob(
        testFilePath,
        testClientId,
        printerId
      )

      expect(result.success).toBe(true)
    }
  })

  test('reads actual file content', async () => {
    await uploadPrintJob(
      testFilePath,
      testClientId,
      testPrinterId
    )

    // Verify that the actual file content was read
    const fileContent = readFileSync(testFilePath)
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        Body: fileContent
      })
    )
  })

  test('sets correct content type for PDF', async () => {
    await uploadPrintJob(
      testFilePath,
      testClientId,
      testPrinterId
    )

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        ContentType: 'application/pdf'
      })
    )
  })
})
