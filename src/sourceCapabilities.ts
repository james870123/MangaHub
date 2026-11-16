/** Source capability declarations. These describe supported access, not content licensing. */
export type ImageTransport = 'direct-https' | 'site-managed' | 'none';
export type SourceManifest = {
  id: string;
  name: string;
  hosts: readonly string[];
  chapterIndex: boolean;
  imageTransport: ImageTransport;
  publicImageApi: 'documented' | 'unverified' | 'none';
  notes: string;
};
export const SOURCE_MANIFESTS: readonly SourceManifest[] = [
  {
    id: 'comicbox', name: 'ComicBox', hosts: ['www.comicbox.xyz'],
    chapterIndex: true, imageTransport: 'site-managed', publicImageApi: 'unverified',
    notes: '可取得章節索引；圖片分段及網站專用處理，不可作為一般圖片 URL。尚未找到已確認授權的公開圖片 API。',
  },
  {
    id: 'direct-images', name: '自有／授權的直接圖片', hosts: [],
    chapterIndex: false, imageTransport: 'direct-https', publicImageApi: 'none',
    notes: '使用者自行提供可存取的 HTTPS JPG、PNG、WebP、GIF、AVIF 等圖片網址，交給 MangaHub Reader。',
  },
];
export function sourceForUrl(input: string): SourceManifest {
  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'https:') {
      const source = SOURCE_MANIFESTS.find(item => item.hosts.includes(parsed.hostname.toLowerCase()));
      if (source) return source;
    }
  } catch { /* invalid input, use general entry */ }
  return SOURCE_MANIFESTS[1];
}
export function checkDirectImageUrls(lines: string): {urls: string[]; errors: string[]} {
  const urls: string[] = [], errors: string[] = [];
  for (const line of lines.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password) throw Error('需使用不含帳密的 HTTPS 網址');
      if (SOURCE_MANIFESTS[0].hosts.includes(u.hostname.toLowerCase()) || /\.b_\d+(?:$|\?)/i.test(u.pathname)) throw Error('不接受網站分段資料或 ComicBox 章節網址');
      if (!/\.(?:jpe?g|png|webp|gif|avif)$/i.test(u.pathname)) throw Error('網址路徑需以常見圖片副檔名結尾');
      if (urls.length >= 500) throw Error('一次最多 500 張');
      urls.push(u.href);
    } catch (e) { errors.push(`${value.slice(0, 90)}：${String(e)}`); }
  }
  return { urls, errors };
}
