// Blob（写真）を画面に出すための URL。URL.createObjectURL が使えない環境（jsdom など）では何もしない。
// 使われなくなった URL は prune で、全部は dispose で revoke する。
export class BlobUrls {
  private readonly urls = new Map<Blob, string>();

  urlFor(blob: Blob): string | null {
    const known = this.urls.get(blob);
    if (known) return known;
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    try {
      const url = URL.createObjectURL(blob);
      this.urls.set(blob, url);
      return url;
    } catch {
      return null;
    }
  }

  /** keep に含まれない Blob の URL を解放する */
  prune(keep: ReadonlySet<Blob>): void {
    for (const [blob, url] of this.urls) {
      if (keep.has(blob)) continue;
      this.urls.delete(blob);
      this.revoke(url);
    }
  }

  dispose(): void {
    for (const url of this.urls.values()) this.revoke(url);
    this.urls.clear();
  }

  private revoke(url: string): void {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // 解放できなくても続ける
    }
  }
}
