export function getLinkUrl(key: string): string {
  const el = document.querySelector<HTMLAnchorElement>(`#footer-links a[data-key="${key}"]`);
  return el?.href ?? '#';
}
