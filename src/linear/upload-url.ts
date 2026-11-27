const UPLOAD_ORIGIN = 'https://uploads.linear.app/';

/**
 * Whether `url` is a file on Linear's upload host, the only destination the sync downloads, spelled as such.
 * The URL parser drops leading and trailing spaces and controls and removes tabs and newlines anywhere, while
 * a repository path reads them as part of the name: a spelling the parser would rewrite is no upload, so
 * nothing reads one destination as an upload and as a repository file. Linear's upload URLs hold no space or
 * control character at all, so none is accepted, also not before a fragment the download cuts off. Linear
 * writes the scheme and host in lowercase and without a port, so another spelling of them is no upload either.
 */
export function isUploadUrl(url: string): boolean {
  if (!url.startsWith(UPLOAD_ORIGIN) || /[\u0000-\u0020\u007f]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'uploads.linear.app' && parsed.username === '' && parsed.password === '' && parsed.port === '';
  } catch {
    return false;
  }
}
