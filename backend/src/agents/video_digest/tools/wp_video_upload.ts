import { uploadImageBuffer } from '../../../agents/publisher/tools/wp_api_client';

/**
 * Upload a video buffer to the WordPress media library.
 * Returns the public source_url for use with the Instagram Graph API.
 */
export async function uploadVideo(params: {
  buffer:   Buffer;
  filename: string;
}): Promise<string> {
  const media = await uploadImageBuffer(
    params.buffer,
    params.filename,
    params.filename.replace(/\.mp4$/, ''),
    'video/mp4'
  );
  return media.source_url;
}
