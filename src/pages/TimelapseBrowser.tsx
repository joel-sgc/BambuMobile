import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PullToRefresh from 'react-simple-pull-to-refresh';

interface FileEntry {
  name: string;
  size: number;
  is_dir: boolean;
  modified: number;
}

const VIDEO_EXTS = ['.avi', '.mp4', '.mov'];
const isVideo = (n: string) =>
  VIDEO_EXTS.some((e) => n.toLowerCase().endsWith(e));

function stemOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(0, dot) : name;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FTP_DIR = '/timelapse/';

type ThumbState = 'idle' | 'loading' | 'loaded' | 'failed';

// Module-level thumbnail cache — survives component unmount so navigating away
// and back doesn't restart the slow sequential FTP thumbnail-loading loop.
// Keyed by video filename; value is a full data-URI (mime baked in).
const thumbCache: Record<string, string> = {};
const thumbStateCache: Record<string, ThumbState> = {};

export default function TimelapseBrowser({
  onMenuOpen,
}: {
  onMenuOpen: () => void;
}) {
  const [videos, setVideos] = useState<FileEntry[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>(thumbCache);
  const [thumbStates, setThumbStates] = useState<Record<string, ThumbState>>(thumbStateCache);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);
  const attemptedRef = useRef<Set<string>>(new Set(Object.keys(thumbStateCache)));
  const loadGenRef = useRef(0);

  useEffect(() => {
    fetchFiles();
  }, []);

  async function fetchFiles() {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError('');
    setSelected(new Set());
    setSelectMode(false);
    attemptedRef.current.clear();
    setThumbnails({});
    setThumbStates({});
    // Bust the module-level cache so a manual refresh fetches fresh thumbnails.
    Object.keys(thumbCache).forEach((k) => delete thumbCache[k]);
    Object.keys(thumbStateCache).forEach((k) => delete thumbStateCache[k]);
    try {
      const all = await invoke<FileEntry[]>('list_files', { path: FTP_DIR });
      if (loadGenRef.current !== gen) return;
      const vids = all.filter((f) => isVideo(f.name));
      setVideos(vids);
      loadThumbnails(vids, gen);
    } catch (e) {
      if (loadGenRef.current !== gen) return;
      setError(String(e));
    } finally {
      if (loadGenRef.current === gen) setLoading(false);
    }
  }

  // Loads thumbnails one at a time to avoid overwhelming the printer's FTP server.
  // Tries both the flat layout ({stem}.jpg next to the video) and a thumbnail/
  // subdirectory in case the printer organises them separately.
  async function loadThumbnails(vids: FileEntry[], gen: number) {
    for (const v of vids) {
      if (loadGenRef.current !== gen) return;
      const stem = stemOf(v.name);
      const candidates = [
        { path: `${FTP_DIR}${stem}.jpg`, mime: 'image/jpeg' },
        { path: `${FTP_DIR}${stem}.png`, mime: 'image/png' },
        { path: `${FTP_DIR}thumbnail/${stem}.jpg`, mime: 'image/jpeg' },
        { path: `${FTP_DIR}thumbnail/${stem}.png`, mime: 'image/png' },
      ];

      let loaded = false;
      for (const { path, mime } of candidates) {
        if (attemptedRef.current.has(path)) continue;
        attemptedRef.current.add(path);
        setThumbStates((s) => ({ ...s, [v.name]: 'loading' }));
        try {
          const b64 = await invoke<string>('fetch_thumbnail', { path });
          // Store as a full data URL so the MIME type is baked in
          const dataUrl = `data:${mime};base64,${b64}`;
          setThumbnails((t) => ({ ...t, [v.name]: dataUrl }));
          thumbCache[v.name] = dataUrl;
          setThumbStates((s) => ({ ...s, [v.name]: 'loaded' }));
          thumbStateCache[v.name] = 'loaded';
          loaded = true;
          break;
        } catch {
          // try next candidate
        }
      }
      if (!loaded) {
        setThumbStates((s) => ({ ...s, [v.name]: 'failed' }));
        thumbStateCache[v.name] = 'failed';
      }
    }
  }

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  function startLongPress(name: string) {
    didLongPressRef.current = false;
    longPressTimer.current = setTimeout(() => {
      didLongPressRef.current = true;
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

  async function handleDeleteSelected() {
    const names = [...selected];
    setSelectMode(false);
    setSelected(new Set());
    const errors: string[] = [];
    for (const name of names) {
      try {
        await invoke('delete_entry', { path: `${FTP_DIR}${name}` });
        setVideos((v) => v.filter((f) => f.name !== name));
        setThumbnails((t) => {
          const n = { ...t };
          delete n[name];
          return n;
        });
        setThumbStates((s) => {
          const n = { ...s };
          delete n[name];
          return n;
        });
        // Keep module-level cache in sync.
        delete thumbCache[name];
        delete thumbStateCache[name];
      } catch (e) {
        errors.push(String(e));
      }
    }
    if (errors.length > 0) setError(errors.join('\n'));
    else
      showToast(`Deleted ${names.length} file${names.length > 1 ? 's' : ''}`);
  }

  async function handleDownloadSelected() {
    setDownloading(true);
    const names = [...selected];
    setSelectMode(false);
    setSelected(new Set());
    const errors: string[] = [];
    for (const name of names) {
      try {
        await invoke<string>('download_file', { path: `${FTP_DIR}${name}` });
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

  return (
    <div className='min-h-screen bg-zinc-950 text-white flex flex-col select-none'>
      {/* Header */}
      <div
        className='sticky top-0 z-10 flex items-center px-4 pb-3 bg-zinc-900 border-b border-zinc-800 gap-3 shrink-0'
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
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
            <button
              onClick={handleDownloadSelected}
              disabled={downloading || selected.size == 0}
              className='shrink-0 p-2 text-teal-400 hover:text-teal-300 disabled:opacity-25 transition-colors'
              aria-label='Download'>
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
            <button
              onClick={handleDeleteSelected}
              disabled={selected.size == 0}
              className='shrink-0 p-2 text-red-400 hover:text-red-300 disabled:opacity-25 transition-colors'
              aria-label='Delete'>
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
            <button
              onClick={() => {
                if (selected.size == videos.length) {
                  setSelected(new Set());
                } else {
                  setSelected(new Set(videos.map((v) => v.name)));
                }
              }}
              className='shrink-0 text-xs text-zinc-400 hover:text-white font-medium pl-1'>
              All
            </button>
          </>
        : <>
            <button
              onClick={onMenuOpen}
              className='text-zinc-400 hover:text-white transition-colors'>
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
            </button>
            <h1 className='font-semibold text-lg flex-1'>Timelapses</h1>
            <button
              onClick={fetchFiles}
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

      <PullToRefresh onRefresh={fetchFiles} className='flex-1 overflow-y-auto'>
        <>
          {loading && (
            <div className='flex justify-center py-16'>
              <div className='w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin' />
            </div>
          )}

          {!loading && error && (
            <div className='m-4 bg-red-950/40 border border-red-800/50 rounded-xl px-4 py-3'>
              <p className='text-red-400 text-sm font-medium'>Error</p>
              <p className='text-red-500/80 text-xs mt-1 font-mono'>{error}</p>
            </div>
          )}

          {!loading && !error && videos.length === 0 && (
            <p className='text-zinc-600 text-sm text-center py-16'>
              No timelapses found
            </p>
          )}

          {!loading && videos.length > 0 && (
            <div className='grid grid-cols-2 gap-3 p-4'>
              {videos.map((vid) => {
                const thumb = thumbnails[vid.name];
                const tState = thumbStates[vid.name] ?? 'idle';
                const isSelected = selected.has(vid.name);

                return (
                  <div
                    key={vid.name}
                    className={`bg-zinc-900 rounded-xl overflow-hidden border transition-colors ${
                      isSelected ? 'border-teal-500' : 'border-zinc-800'
                    }`}
                    onPointerDown={() => startLongPress(vid.name)}
                    onPointerUp={cancelLongPress}
                    onPointerCancel={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                    onClick={() => {
                      if (didLongPressRef.current) {
                        didLongPressRef.current = false;
                        return;
                      }
                      if (selectMode) toggleSelect(vid.name);
                      else if (thumb) setPreview(thumb);
                    }}>
                    {/* Thumbnail area */}
                    <div className='aspect-video bg-zinc-800 flex items-center justify-center relative overflow-hidden'>
                      {tState === 'loaded' && thumb ?
                        <img
                          src={thumb}
                          className='w-full h-full object-cover'
                          alt=''
                        />
                      : tState === 'loading' ?
                        <div className='w-5 h-5 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin' />
                      : <svg
                          className='w-8 h-8 text-zinc-600'
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
                      }

                      {/* Select overlay */}
                      {selectMode && (
                        <div
                          className={`absolute inset-0 flex items-center justify-center transition-colors ${
                            isSelected ? 'bg-teal-900/60' : 'bg-black/20'
                          }`}>
                          <div
                            className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${
                              isSelected ?
                                'bg-teal-500 border-teal-500'
                              : 'border-white/70'
                            }`}>
                            {isSelected && (
                              <svg
                                className='w-3.5 h-3.5 text-white'
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
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Name + size */}
                    <div className='px-2.5 py-2'>
                      <p className='text-white text-xs font-medium truncate'>
                        {vid.name}
                      </p>
                      <p className='text-zinc-600 text-xs mt-0.5'>
                        {formatSize(vid.size)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      </PullToRefresh>

      {/* Preview modal */}
      {preview && (
        <div
          className='fixed inset-0 z-50 bg-black/95 flex items-center justify-center'
          onClick={() => setPreview(null)}>
          <img
            src={preview}
            className='max-w-full max-h-full object-contain'
            alt='Preview'
          />
        </div>
      )}
    </div>
  );
}
