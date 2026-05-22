import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PullToRefresh from 'react-simple-pull-to-refresh';

interface FileEntry {
  name: string;
  size: number;
  is_dir: boolean;
  modified: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const VIDEO_EXTS = ['.avi', '.mp4', '.mov'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];
const isVideo = (n: string) =>
  VIDEO_EXTS.some((e) => n.toLowerCase().endsWith(e));
const isImage = (n: string) =>
  IMAGE_EXTS.some((e) => n.toLowerCase().endsWith(e));
const isGcode = (n: string) => n.toLowerCase().endsWith('.gcode');

function canPreview(name: string) {
  return isImage(name) || isVideo(name);
}

function stemOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(0, dot) : name;
}

function MenuIcon() {
  return (
    <svg
      className='w-6 h-6'
      fill='none'
      viewBox='0 0 24 24'
      stroke='currentColor'
      strokeWidth={2}>
      <path
        strokeLinecap='round'
        strokeLinejoin='round'
        d='M4 6h16M4 12h16M4 18h16'
      />
    </svg>
  );
}

type MenuPos = { top: number; right: number };

export default function FileManager({
  onMenuOpen,
  path,
  onPathChange,
}: {
  onMenuOpen: () => void;
  path: string;
  onPathChange: (p: string) => void;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [openMenuName, setOpenMenuName] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [printConfirm, setPrintConfirm] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [bedLeveling, setBedLeveling] = useState(true);
  const [timelapse, setTimelapse] = useState(false);
  const [useAms, setUseAms] = useState(true);
  const [printing, setPrinting] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);

  useEffect(() => {
    fetchFiles(path);
  }, [path]);

  async function fetchFiles(p: string) {
    setLoading(true);
    setError('');
    setSelected(new Set());
    setSelectMode(false);
    setOpenMenuName(null);
    try {
      const result = await invoke<FileEntry[]>('list_files', { path: p });
      setFiles(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Long-press to enter select mode ────────────────────────────────────────

  function startLongPress(name: string) {
    didLongPressRef.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPressRef.current = true;
      setOpenMenuName(null);
      setSelectMode(true);
      setSelected(new Set([name]));
    }, 500);
  }

  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function toggleSelect(name: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }

  // ── Dropdown menu ───────────────────────────────────────────────────────────

  function openMenu(name: string, e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    cancelLongPress();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOpenMenuName(name);
    setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }

  // ── Preview ─────────────────────────────────────────────────────────────────

  async function handlePreview(name: string) {
    setOpenMenuName(null);
    if (!canPreview(name)) return;
    setPreviewLoading(true);
    try {
      let fetchPath: string;
      if (isVideo(name)) {
        const jpgName = `${stemOf(name)}.jpg`;
        const has = files.some((f) => f.name === jpgName);
        if (!has) {
          showToast('No preview available', false);
          setPreviewLoading(false);
          return;
        }
        fetchPath = (path.endsWith('/') ? path : path + '/') + jpgName;
      } else {
        fetchPath = (path.endsWith('/') ? path : path + '/') + name;
      }
      const b64 = await invoke<string>('fetch_thumbnail', { path: fetchPath });
      setPreview(b64);
    } catch {
      showToast('Preview failed', false);
    } finally {
      setPreviewLoading(false);
    }
  }

  // ── Download ────────────────────────────────────────────────────────────────

  async function handleDownloadOne(name: string) {
    setOpenMenuName(null);
    const fullPath = (path.endsWith('/') ? path : path + '/') + name;
    try {
      await invoke<string>('download_file', { path: fullPath });
      showToast(`Saved ${name}`);
    } catch (e) {
      showToast(String(e), false);
    }
  }

  async function handleDownloadSelected() {
    const names = [...selected].filter((name) => {
      const entry = files.find((f) => f.name === name);
      return entry && !entry.is_dir;
    });
    if (names.length === 0) {
      showToast('No files selected to download', false);
      return;
    }
    setDownloading(true);
    setSelectMode(false);
    setSelected(new Set());
    const errors: string[] = [];
    for (const name of names) {
      const fullPath = (path.endsWith('/') ? path : path + '/') + name;
      try {
        await invoke<string>('download_file', { path: fullPath });
      } catch (e) {
        errors.push(String(e));
      }
    }
    setDownloading(false);
    if (errors.length > 0) setError(errors.join('\n'));
    else
      showToast(
        names.length === 1 ?
          `Saved ${names[0]}`
        : `Saved ${names.length} files`,
      );
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDeleteOne(name: string) {
    setOpenMenuName(null);
    const fullPath = (path.endsWith('/') ? path : path + '/') + name;
    try {
      await invoke('delete_entry', { path: fullPath });
      setFiles((f) => f.filter((e) => e.name !== name));
      showToast(`Deleted ${name}`);
    } catch (e) {
      showToast(String(e), false);
    }
  }

  async function handleDeleteSelected() {
    const names = [...selected];
    setSelectMode(false);
    setSelected(new Set());
    const errors: string[] = [];
    for (const name of names) {
      const fullPath = (path.endsWith('/') ? path : path + '/') + name;
      try {
        await invoke('delete_entry', { path: fullPath });
        setFiles((f) => f.filter((e) => e.name !== name));
      } catch (e) {
        errors.push(String(e));
      }
    }
    if (errors.length > 0) setError(errors.join('\n'));
    else
      showToast(`Deleted ${names.length} item${names.length > 1 ? 's' : ''}`);
  }

  // ── Print ───────────────────────────────────────────────────────────────────

  async function handlePrint() {
    if (!printConfirm) return;
    setPrinting(true);
    try {
      await invoke('start_print', {
        path: printConfirm.path,
        bedLeveling,
        flowCali: false,
        timelapse,
        useAms,
      });
      setPrintConfirm(null);
      showToast('Print started');
    } catch (e) {
      showToast(String(e), false);
    } finally {
      setPrinting(false);
    }
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  function enterDir(entry: FileEntry) {
    if (!entry.is_dir) return;
    onPathChange(
      path.endsWith('/') ? `${path}${entry.name}/` : `${path}/${entry.name}/`,
    );
  }

  function goUp() {
    if (path === '/') return;
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
    onPathChange(trimmed.substring(0, trimmed.lastIndexOf('/') + 1) || '/');
  }

  const hasFileSelected = [...selected].some((name) => {
    const entry = files.find((f) => f.name === name);
    return entry && !entry.is_dir;
  });

  const menuEntry = files.find((f) => f.name === openMenuName);

  return (
    <div className='min-h-screen bg-zinc-950 text-white flex flex-col select-none'>
      {/* Header + breadcrumb — sticky together so breadcrumb doesn't scroll away */}
      <div className='sticky top-0 z-10 shrink-0'>
        <div
          className='flex items-center px-4 pb-3 bg-zinc-900 border-b border-zinc-800 gap-3'
          style={{
            paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)',
          }}>
          {selectMode ?
            <>
              <button
                onClick={() => {
                  setSelectMode(false);
                  setSelected(new Set());
                }}
                className='text-zinc-400 hover:text-white transition-colors text-sm font-medium shrink-0'>
                Cancel
              </button>
              <span className='flex-1 text-sm text-zinc-300 px-2'>
                {selected.size} selected
              </span>
              {selected.size > 0 && (
                <>
                  {hasFileSelected && (
                    <button
                      onClick={handleDownloadSelected}
                      disabled={downloading}
                      className='shrink-0 p-2 text-teal-400 hover:text-teal-300 transition-colors disabled:opacity-40'
                      aria-label='Download selected'>
                      {downloading ?
                        <span className='w-5 h-5 border-2 border-teal-400 border-t-transparent rounded-full animate-spin block' />
                      : <svg
                          className='w-5 h-5'
                          fill='none'
                          viewBox='0 0 24 24'
                          stroke='currentColor'
                          strokeWidth={2}>
                          <path
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            d='M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4'
                          />
                        </svg>
                      }
                    </button>
                  )}
                  <button
                    onClick={handleDeleteSelected}
                    className='shrink-0 p-2 text-red-400 hover:text-red-300 transition-colors'
                    aria-label='Delete selected'>
                    <svg
                      className='w-5 h-5'
                      fill='none'
                      viewBox='0 0 24 24'
                      stroke='currentColor'
                      strokeWidth={2}>
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        d='M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16'
                      />
                    </svg>
                  </button>
                </>
              )}
              <button
                onClick={() => setSelected(new Set(files.map((f) => f.name)))}
                className='shrink-0 text-xs text-zinc-400 hover:text-white font-medium pl-1'>
                All
              </button>
            </>
          : <>
              <button
                onClick={onMenuOpen}
                className='text-zinc-400 hover:text-white transition-colors'>
                <MenuIcon />
              </button>
              <h1 className='font-semibold text-lg flex-1'>File Manager</h1>
              <button
                onClick={() => fetchFiles(path)}
                className='text-zinc-400 hover:text-white transition-colors'>
                <svg
                  className='w-5 h-5'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                  strokeWidth={2}>
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    d='M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15'
                  />
                </svg>
              </button>
            </>
          }
        </div>

        {/* Breadcrumb */}
        <div className='flex items-center gap-2 px-4 py-2 bg-zinc-900 border-b border-zinc-800'>
          {path !== '/' && (
            <button
              onClick={goUp}
              className='text-zinc-400 hover:text-white transition-colors shrink-0'>
              <svg
                className='w-4 h-4'
                fill='none'
                viewBox='0 0 24 24'
                stroke='currentColor'
                strokeWidth={2.5}>
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  d='M15 19l-7-7 7-7'
                />
              </svg>
            </button>
          )}
          <span className='text-zinc-500 text-xs font-mono truncate'>
            {path}
          </span>
        </div>
      </div>
      {/* end sticky wrapper */}

      {/* Toast */}
      {toast && (
        <div
          className={`mx-4 mt-3 border rounded-xl px-4 py-2 shrink-0 ${
            toast.ok ?
              'bg-teal-950/60 border-teal-700/50'
            : 'bg-red-950/40 border-red-800/50'
          }`}>
          <p
            className={`text-sm font-medium ${toast.ok ? 'text-teal-400' : 'text-red-400'}`}>
            {toast.msg}
          </p>
        </div>
      )}

      {/* Content */}
      <PullToRefresh
        onRefresh={() => fetchFiles(path)}
        className='flex-1 overflow-y-auto'>
        <>
          {loading && (
            <div className='flex justify-center py-16'>
              <div className='w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin' />
            </div>
          )}

          {!loading && error && (
            <div className='m-4 bg-red-950/40 border border-red-800/50 rounded-xl px-4 py-3'>
              <p className='text-red-400 text-sm font-medium'>Error</p>
              <p className='text-red-500/80 text-xs mt-1'>{error}</p>
            </div>
          )}

          {!loading && !error && files.length === 0 && (
            <p className='text-zinc-600 text-sm text-center py-16'>
              Empty directory
            </p>
          )}

          {!loading &&
            files.map((entry) => {
              const isSelected = selected.has(entry.name);
              return (
                <div
                  key={entry.name}
                  className={`flex items-center gap-3 px-4 py-3 border-b border-zinc-800/40 transition-colors ${
                    isSelected ? 'bg-teal-950/30' : ''
                  }`}
                  onPointerDown={() => startLongPress(entry.name)}
                  onPointerUp={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  onContextMenu={(e) => e.preventDefault()}>
                  {/* Checkbox (select mode — all items) */}
                  {selectMode && (
                    <button
                      onClick={() => toggleSelect(entry.name)}
                      className={`shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        isSelected ?
                          'bg-teal-500 border-teal-500'
                        : 'border-zinc-600'
                      }`}>
                      {isSelected && (
                        <svg
                          className='w-3 h-3 text-white'
                          fill='none'
                          viewBox='0 0 24 24'
                          stroke='currentColor'
                          strokeWidth={3}>
                          <path
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            d='M5 13l4 4L19 7'
                          />
                        </svg>
                      )}
                    </button>
                  )}

                  {/* Icon */}
                  <div className='shrink-0 text-zinc-500'>
                    {entry.is_dir ?
                      <svg
                        className='w-5 h-5 text-teal-600'
                        fill='currentColor'
                        viewBox='0 0 24 24'>
                        <path d='M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z' />
                      </svg>
                    : isVideo(entry.name) ?
                      <svg
                        className='w-5 h-5 text-purple-500'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={1.5}>
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z'
                        />
                      </svg>
                    : isImage(entry.name) ?
                      <svg
                        className='w-5 h-5 text-sky-500'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={1.5}>
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z'
                        />
                      </svg>
                    : isGcode(entry.name) ?
                      <svg
                        className='w-5 h-5 text-green-500'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={1.5}>
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M6 3h12M6 8h12M6 13h6m-6 5h4'
                        />
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M16 17l2 2 4-4'
                        />
                      </svg>
                    : <svg
                        className='w-5 h-5'
                        fill='none'
                        viewBox='0 0 24 24'
                        stroke='currentColor'
                        strokeWidth={1.5}>
                        <path
                          strokeLinecap='round'
                          strokeLinejoin='round'
                          d='M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
                        />
                      </svg>
                    }
                  </div>

                  {/* Name + size */}
                  <button
                    className='flex-1 text-left min-w-0'
                    onClick={() => {
                      if (didLongPressRef.current) {
                        didLongPressRef.current = false;
                        return;
                      }
                      if (selectMode) toggleSelect(entry.name);
                      else enterDir(entry);
                    }}>
                    <p className='text-white text-sm truncate'>{entry.name}</p>
                    {!entry.is_dir && (
                      <p className='text-zinc-600 text-xs mt-0.5'>
                        {formatSize(entry.size)}
                      </p>
                    )}
                  </button>

                  {/* ⋮ menu button (normal mode only) */}
                  {!selectMode && (
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => openMenu(entry.name, e)}
                      className='shrink-0 w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors'>
                      <svg
                        className='w-4 h-4'
                        fill='currentColor'
                        viewBox='0 0 24 24'>
                        <circle cx='12' cy='5' r='1.5' />
                        <circle cx='12' cy='12' r='1.5' />
                        <circle cx='12' cy='19' r='1.5' />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
        </>
      </PullToRefresh>

      {/* Dropdown menu */}
      {openMenuName && menuPos && menuEntry && (
        <>
          <div
            className='fixed inset-0 z-40'
            onClick={() => setOpenMenuName(null)}
          />
          <div
            className='fixed z-50 bg-zinc-800 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden min-w-36'
            style={{ top: menuPos.top, right: menuPos.right }}>
            {!menuEntry.is_dir && isGcode(openMenuName) && (
              <button
                onClick={() => {
                  setOpenMenuName(null);
                  const fullPath =
                    (path.endsWith('/') ? path : path + '/') + openMenuName;
                  setPrintConfirm({ path: fullPath, name: openMenuName });
                }}
                className='flex items-center gap-2.5 w-full px-4 py-3 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors text-left'>
                <svg
                  className='w-4 h-4 text-teal-400'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                  strokeWidth={1.75}>
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    d='M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z'
                  />
                </svg>
                Print
              </button>
            )}
            {!menuEntry.is_dir && canPreview(openMenuName) && (
              <button
                onClick={() => handlePreview(openMenuName)}
                className='flex items-center gap-2.5 w-full px-4 py-3 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors text-left'>
                <svg
                  className='w-4 h-4 text-zinc-400'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                  strokeWidth={1.75}>
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
                  />
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    d='M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'
                  />
                </svg>
                Preview
              </button>
            )}
            {!menuEntry.is_dir && (
              <button
                onClick={() => handleDownloadOne(openMenuName)}
                className='flex items-center gap-2.5 w-full px-4 py-3 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors text-left'>
                <svg
                  className='w-4 h-4 text-zinc-400'
                  fill='none'
                  viewBox='0 0 24 24'
                  stroke='currentColor'
                  strokeWidth={1.75}>
                  <path
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    d='M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4'
                  />
                </svg>
                Download
              </button>
            )}
            {!menuEntry.is_dir && <div className='border-t border-zinc-700' />}
            <button
              onClick={() => handleDeleteOne(openMenuName)}
              className='flex items-center gap-2.5 w-full px-4 py-3 text-sm text-red-400 hover:bg-zinc-700 transition-colors text-left'>
              <svg
                className='w-4 h-4'
                fill='none'
                viewBox='0 0 24 24'
                stroke='currentColor'
                strokeWidth={1.75}>
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  d='M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16'
                />
              </svg>
              Delete
            </button>
          </div>
        </>
      )}

      {/* Preview loading spinner */}
      {previewLoading && (
        <div className='fixed inset-0 z-50 bg-black/80 flex items-center justify-center'>
          <div className='w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin' />
        </div>
      )}

      {/* Preview modal */}
      {preview && (
        <div
          className='fixed inset-0 z-50 bg-black/95 flex items-center justify-center'
          onClick={() => setPreview(null)}>
          <img
            src={`data:image/jpeg;base64,${preview}`}
            className='max-w-full max-h-full object-contain'
            alt='Preview'
          />
        </div>
      )}

      {/* Print confirmation sheet */}
      {printConfirm && (
        <>
          <div
            className='fixed inset-0 z-50 bg-black/70'
            onClick={() => !printing && setPrintConfirm(null)}
          />
          <div
            className='fixed bottom-0 left-0 right-0 z-50 bg-zinc-900 rounded-t-2xl p-6 flex flex-col gap-5'
            style={{
              paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)',
            }}>
            <div className='flex flex-col gap-1'>
              <h2 className='text-white font-semibold text-lg'>Start Print</h2>
              <p className='text-zinc-500 text-sm truncate'>
                {printConfirm.name}
              </p>
            </div>

            <div className='flex flex-col gap-0 bg-zinc-800 rounded-xl overflow-hidden divide-y divide-zinc-700/50'>
              {(
                [
                  {
                    label: 'Bed Leveling',
                    value: bedLeveling,
                    set: setBedLeveling,
                  },
                  { label: 'Timelapse', value: timelapse, set: setTimelapse },
                  { label: 'Use AMS', value: useAms, set: setUseAms },
                ] as const
              ).map(({ label, value, set }) => (
                <button
                  key={label}
                  onClick={() => set(!value)}
                  className='flex items-center justify-between px-4 py-3.5 text-left'>
                  <span className='text-white text-sm'>{label}</span>
                  <div
                    className={`w-11 h-6 rounded-full transition-colors relative ${value ? 'bg-teal-500' : 'bg-zinc-600'}`}>
                    <div
                      className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`}
                    />
                  </div>
                </button>
              ))}
            </div>

            <button
              onClick={handlePrint}
              disabled={printing}
              className='bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white font-semibold rounded-xl py-3.5 transition-colors'>
              {printing ? 'Starting…' : 'Start Print'}
            </button>
            <button
              onClick={() => setPrintConfirm(null)}
              disabled={printing}
              className='text-zinc-500 text-sm font-medium py-1'>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
