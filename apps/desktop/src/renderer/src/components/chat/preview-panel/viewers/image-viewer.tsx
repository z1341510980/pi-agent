export function ImageViewer({ src, alt }: { src: string; alt?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <img src={src} alt={alt ?? 'preview'} className="max-h-full max-w-full object-contain" />
    </div>
  )
}
