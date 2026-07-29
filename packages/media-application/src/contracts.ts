export type ImageArtifact = {
  readonly bytes: Buffer;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly model: string;
  readonly width?: number;
  readonly height?: number;
  readonly sourceUrl?: string;
};

export type ImageGenerator = {
  generate(prompt: string): Promise<ImageArtifact>;
};

export type ObjectStorage = {
  put(objectKey: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(objectKey: string): Promise<{ readonly bytes: Buffer; readonly mimeType: string }>;
};
