// src/services/r2.ts
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'stream';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string;
}

export interface R2Service {
  upload(
    key: string,
    body: Readable | Buffer,
    contentType?: string
  ): Promise<{ url: string; size: number }>;
  uploadStream(
    key: string,
    stream: Readable,
    contentType?: string
  ): Promise<{ url: string; size: number }>;
  delete(key: string): Promise<void>;
  getPublicUrl(key: string): string;
}

export function createR2Service(config: R2Config): R2Service {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  function getPublicUrl(key: string): string {
    const baseUrl = config.publicUrl.endsWith('/')
      ? config.publicUrl.slice(0, -1)
      : config.publicUrl;
    return `${baseUrl}/${key}`;
  }

  async function upload(
    key: string,
    body: Readable | Buffer,
    contentType: string = 'audio/aac'
  ): Promise<{ url: string; size: number }> {
    const isBuffer = Buffer.isBuffer(body);

    if (isBuffer) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      );
      return { url: getPublicUrl(key), size: body.length };
    }

    // For streams, use Upload for multipart
    return uploadStream(key, body as Readable, contentType);
  }

  async function uploadStream(
    key: string,
    stream: Readable,
    contentType: string = 'audio/aac'
  ): Promise<{ url: string; size: number }> {
    let totalSize = 0;

    // Track size as data flows through
    stream.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
    });

    const upload = new Upload({
      client,
      params: {
        Bucket: config.bucketName,
        Key: key,
        Body: stream,
        ContentType: contentType,
      },
    });

    await upload.done();

    return { url: getPublicUrl(key), size: totalSize };
  }

  async function deleteObject(key: string): Promise<void> {
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucketName,
        Key: key,
      })
    );
  }

  return {
    upload,
    uploadStream,
    delete: deleteObject,
    getPublicUrl,
  };
}
