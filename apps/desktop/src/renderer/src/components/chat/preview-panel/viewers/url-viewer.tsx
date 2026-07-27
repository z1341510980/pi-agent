export function UrlViewer({ url }: { url: string }) {
  return (
    <iframe src={url} className="h-full w-full border-0" sandbox="allow-same-origin allow-scripts" />
  )
}
