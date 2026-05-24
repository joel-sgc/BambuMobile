import type { AmsTray } from '../vite-env';

export const VT_TRAY_ID = 254;

export default function ExternalSpool({
  tray,
  divided,
  selected,
  active,
  onSelect,
}: {
  tray: AmsTray;
  divided?: boolean;
  selected?: boolean;
  /** True when this spool is currently loaded in the nozzle */
  active?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex items-center w-full gap-4 text-left rounded-lg p-1 transition-colors ${
        divided ? 'pt-4 border-t border-zinc-700/60' : ''
      } ${selected ? 'ring-2 ring-teal-400 bg-teal-950/30' : ''}`}>
      <div className='relative shrink-0'>
        <div
          className={`w-10 h-10 rounded-lg border-2 transition-colors ${
            selected ? 'border-teal-400'
            : active ? 'border-amber-400'
            : 'border-zinc-700'
          }`}
          style={{ backgroundColor: tray.color ? `#${tray.color}` : '#3f3f46' }}
        />
        {active && (
          <span className='absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 border border-zinc-900' />
        )}
      </div>

      <div className='flex flex-col gap-0.5 min-w-0'>
        <span className='text-zinc-400 text-xs'>
          External Spool{active && <span className='ml-1 text-amber-400'>· Loaded</span>}
        </span>
        <span className='text-white font-semibold text-sm'>
          {tray.tray_type}
        </span>
        {tray.name && (
          <span className='text-zinc-400 text-xs truncate'>{tray.name}</span>
        )}
      </div>
    </button>
  );
}
