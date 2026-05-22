export default function ConnectingScreen({ ip }: { ip: string }) {
  return (
    <div
      className='min-h-screen bg-zinc-950 flex flex-col items-center justify-center gap-4'
      style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      <div className='w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin' />
      <p className='text-zinc-400 text-sm'>Connecting to {ip}…</p>
    </div>
  );
}
