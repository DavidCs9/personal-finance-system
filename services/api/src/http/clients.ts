import { S3Client } from '@aws-sdk/client-s3';
import { TextractClient } from '@aws-sdk/client-textract';

export const s3 = new S3Client({});
export const textract = new TextractClient({});

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export const rawSourceBucketName = requiredEnvironment('RAW_EMAIL_BUCKET_NAME');
