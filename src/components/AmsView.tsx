import type { AmsTray, AmsUnit } from '../vite-env';
import { humidityGrade } from '../utils/printer';

export default function AmsView({
  ams,
  selectedTrayId,
  activeGlobalTrayId,
  onSelectTray,
}: {
  ams: AmsUnit[];
  selectedTrayId: number | null;
  /** tray_now from printer status — highlights the currently-loaded slot */
  activeGlobalTrayId?: number;
  onSelectTray: (trayId: number) => void;
}) {
  if (!ams.length) return null;
  return (
    <div className='flex flex-col gap-4 w-full'>
      {ams.map((unit) => {
        const grade = humidityGrade(unit.humidity);
        return (
          <div key={unit.id}>
            <p className='text-zinc-500 text-xs mb-2 flex items-center gap-2'>
              <span>Unit {unit.id + 1}</span>
              <span>·</span>
              <span>
                Humidity{' '}
                <span className={`font-bold ${grade.color}`}>
                  {grade.letter}
                </span>
                <span className='text-zinc-600 ml-1'>({grade.label})</span>
              </span>
            </p>
            <div className='flex gap-3'>
              {unit.trays.map((tray: AmsTray) => {
                // Global tray ID: AMS unit 0 → slots 0-3, unit 1 → slots 4-7, etc.
                const trayId = unit.id * 4 + tray.id;
                const isSelected = selectedTrayId === trayId;
                const isActive = activeGlobalTrayId === trayId;
                return (
                  <button
                    key={tray.id}
                    onClick={() => onSelectTray(trayId)}
                    className={`flex flex-col items-center gap-1 flex-1 rounded-lg p-1 transition-colors ${
                      isSelected ? 'ring-2 ring-teal-400 bg-teal-950/30' : ''
                    }`}>
                    <div className='relative w-full max-w-12'>
                      <div
                        className={`w-full aspect-square rounded-lg border-2 transition-colors ${
                          isSelected ? 'border-teal-400'
                          : isActive ? 'border-amber-400'
                          : 'border-zinc-700'
                        }`}
                        style={{
                          backgroundColor:
                            tray.color ? `#${tray.color}` : '#3f3f46',
                        }}
                      />
                      {/* Small dot indicator for currently loaded tray */}
                      {isActive && (
                        <span className='absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 border border-zinc-900' />
                      )}
                    </div>
                    <span className='text-zinc-400 text-[10px] font-medium'>
                      {tray.tray_type || '—'}
                    </span>
                    {tray.name && (
                      <span className='text-zinc-500 text-[9px] truncate w-full text-center'>
                        {tray.name}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
