import { useEffect, useRef, useState } from 'react';
import { Check, Headphones, LoaderCircle, Music2, Pause, Play, Plus, Sparkles, Trash2 } from 'lucide-react';
import { SOUND_LIBRARY, soundClip, themeBridge } from '../shared/sound-library';
import { bookendCues, type SoundCue, type SoundtrackEdit } from '../shared/soundtrack';
import type { Episode } from '../shared/types';
import { api, post } from './api';
import './soundtrack.css';

const label = { intro: 'Opening', outro: 'Closing', transition: 'Chapter transition', ambience: 'A little atmosphere' };
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const editable = (p?: SoundtrackEdit) => p && ({ enabled: p.enabled, themeId: p.themeId, cues: p.cues });

export function SoundtrackPanel({ episode, disabled, canPlan, refresh, notify, onPreview, onListenAt }: {
  episode: Episode; disabled: boolean; canPlan: boolean; refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void; onPreview: () => void; onListenAt: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState<SoundtrackEdit | undefined>(editable(episode.soundtrack));
  const [busy, setBusy] = useState(false); const [preview, setPreview] = useState<string>();
  const player = useRef<HTMLAudioElement | null>(null);
  const persisted = JSON.stringify(editable(episode.soundtrack));
  useEffect(() => { setDraft(persisted ? JSON.parse(persisted) : undefined); }, [persisted, episode.id]);
  useEffect(() => () => { player.current?.pause(); }, []);
  const changed = JSON.stringify(editable(draft)) !== persisted;
  const locked = busy || disabled;
  const chapters = episode.script?.chapters || [];
  const recorded = episode.status === 'ready' && !!episode.audioFile;
  const dirty = changed || !!episode.soundtrackDirty;

  function stopPreview() { player.current?.pause(); player.current = null; setPreview(undefined); }
  async function listen(clipId: string, key: string, seconds?: number) {
    if (preview === key) { stopPreview(); return; }
    stopPreview(); onPreview();
    const audio = new Audio(`/api/sounds/${clipId}/audio`); player.current = audio; audio.volume = .65;
    audio.onended = () => { if (player.current === audio) stopPreview(); };
    audio.ontimeupdate = () => { if (seconds && audio.currentTime >= seconds && player.current === audio) stopPreview(); };
    audio.onerror = () => { if (player.current === audio) { stopPreview(); notify('This sound could not be played.', true); } };
    try { await audio.play(); if (player.current === audio) setPreview(key); else audio.pause(); }
    catch { if (player.current === audio) { stopPreview(); notify('Press preview again to hear this sound.', true); } }
  }
  function updateCue(id: string, patch: Partial<SoundCue>) {
    stopPreview();
    setDraft(d => d && ({ ...d, cues: d.cues.map(c => c.id === id ? { ...c, ...patch, ...((patch.clipId || patch.chapterIndex !== undefined) ? { reason: 'Chosen for this moment.' } : {}) } : c) }));
  }
  function chooseTheme(themeId: string) {
    stopPreview();
    setDraft(d => d && ({ ...d, themeId, cues: d.cues.map(c => c.kind === 'intro' || c.kind === 'outro' ? { ...c, clipId: themeId } : c.kind === 'transition' ? { ...c, clipId: themeBridge(themeId) } : c) }));
  }
  async function save(mix: boolean) {
    if (!draft || locked) return;
    setBusy(true); stopPreview();
    try {
      if (changed) await api(`/episodes/${episode.id}/soundtrack`, { method: 'PUT', body: JSON.stringify(draft) });
      if (mix) await post(`/episodes/${episode.id}/soundtrack/mix`);
      await refresh(); notify(mix ? 'Your soundtrack is being mixed with the saved narration.' : 'Soundtrack saved for your next recording.');
    } catch (e) { notify((e as Error).message, true); await refresh(); }
    finally { setBusy(false); }
  }
  async function chooseAutomatically() {
    setBusy(true); stopPreview();
    try { await post(`/episodes/${episode.id}/soundtrack/plan`); await refresh(); }
    catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  }
  const freeChapter = chapters.findIndex((_c, index) => index > 0 && !draft?.cues.some(c => c.chapterIndex === index && (c.kind === 'transition' || c.kind === 'ambience')));
  function add(kind: SoundCue['kind']) {
    setDraft(d => {
      if (!d) return d;
      const cue: SoundCue = kind === 'intro' || kind === 'outro' ? bookendCues(chapters.length, d.themeId).find(c => c.kind === kind)! : {
        id: crypto.randomUUID(), kind, clipId: kind === 'transition' ? themeBridge(d.themeId) : 'forest', chapterIndex: freeChapter,
        durationSeconds: kind === 'transition' ? 3 : 12, volumeDb: kind === 'transition' ? -12 : -16, reason: 'Chosen for this moment.',
      };
      return { ...d, cues: [...d.cues, cue].sort((a, b) => (a.kind === 'intro' ? -1 : a.kind === 'outro' ? 100 : a.chapterIndex) - (b.kind === 'intro' ? -1 : b.kind === 'outro' ? 100 : b.chapterIndex)) };
    });
  }

  return <div className="soundtrack-panel">
    <div className="soundtrack-heading"><span className="soundtrack-icon"><Music2 size={23}/></span><div><h2>A little atmosphere.</h2><p>Music at the edges. A few sounds along the way.</p></div></div>
    {episode.soundtrack?.note && <p className="soundtrack-note" role="status">{episode.soundtrack.note}</p>}
    {episode.mixNote && <p className="soundtrack-note">{episode.mixNote}</p>}
    {!draft ? <div className="soundtrack-empty"><p>Let the script guide a few thoughtful cues, or start with opening and closing music.</p><div className="soundtrack-actions"><button className="button primary" disabled={locked || !canPlan} onClick={() => void chooseAutomatically()}>{busy ? <LoaderCircle className="spin" size={16}/> : <Sparkles size={16}/>}Choose sounds automatically</button><button className="button secondary" disabled={locked} onClick={() => setDraft({ enabled: true, themeId: 'warm-piano', cues: bookendCues(chapters.length, 'warm-piano') })}>Add opening & closing</button></div>{!canPlan && <p className="field-hint">Connect your writing room to choose sounds automatically. You can select clips yourself now.</p>}</div>
    : <>
      <div className="soundtrack-options"><label className="checkbox-label"><input type="checkbox" checked={draft.enabled} disabled={locked} onChange={e => setDraft({ ...draft, enabled: e.target.checked })}/>Include music & ambience</label><span className="soundtrack-count">{draft.enabled ? `${draft.cues.length} short cues` : 'Voice only'}</span></div>
      {draft.enabled && <>
        <label className="soundtrack-theme">Musical theme<select value={draft.themeId} disabled={locked} onChange={e => chooseTheme(e.target.value)}>{SOUND_LIBRARY.filter(c => c.kind === 'music').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><small>{soundClip(draft.themeId)?.description}</small></label>
        <div className="soundtrack-cues">{draft.cues.map(cue => {
          const clip = soundClip(cue.clipId)!;
          const rendered = !dirty && episode.renderedCues?.find(c => c.id === cue.id);
          return <article className="soundtrack-cue" key={cue.id}>
            <div className="soundtrack-cue-heading"><strong>{label[cue.kind]}</strong><span>{rendered ? clock(rendered.startSeconds) : cue.kind === 'intro' ? 'Start of episode' : cue.kind === 'outro' ? 'End of episode' : `Chapter ${cue.chapterIndex + 1}`}</span><button className="soundtrack-remove" aria-label={`Remove ${label[cue.kind]}${cue.kind === 'ambience' || cue.kind === 'transition' ? ` at chapter ${cue.chapterIndex + 1}` : ''}`} disabled={locked} onClick={() => setDraft({ ...draft, cues: draft.cues.filter(c => c.id !== cue.id) })}><Trash2 size={15}/></button></div>
            <div className="soundtrack-cue-controls"><label>Sound<select aria-label={`Sound for ${label[cue.kind]} ${cue.chapterIndex + 1}`} value={cue.clipId} disabled={locked} onChange={e => updateCue(cue.id, { clipId: e.target.value })}>{SOUND_LIBRARY.filter(c => c.kind === clip.kind).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><button className="button secondary sound-preview" aria-label={`${preview === cue.id ? 'Pause preview of' : 'Preview'} ${clip.name}`} onClick={() => void listen(clip.id, cue.id, cue.durationSeconds)}>{preview === cue.id ? <Pause size={15}/> : <Play size={15}/>} {preview === cue.id ? 'Pause' : 'Preview'}</button></div>
            {(cue.kind === 'transition' || cue.kind === 'ambience') && <label className="soundtrack-placement">At the start of<select aria-label={`Chapter for ${clip.name}`} disabled={locked} value={cue.chapterIndex} onChange={e => updateCue(cue.id, { chapterIndex: Number(e.target.value) })}>{chapters.map((c, i) => i > 0 && <option key={i} value={i} disabled={draft.cues.some(other => other.id !== cue.id && other.chapterIndex === i && (other.kind === 'transition' || other.kind === 'ambience'))}>{i + 1}. {c.title.replace(/^\d+[.)]\s*/, '')}</option>)}</select></label>}
            <p className="soundtrack-reason">{cue.reason}</p>
            <div className="soundtrack-levels"><label>Length <span><input aria-label={`Duration for ${clip.name}`} type="number" min="1" max={clip.seconds} step="1" value={cue.durationSeconds} disabled={locked} onChange={e => { const n = Number(e.target.value); if (n >= 1 && n <= clip.seconds) updateCue(cue.id, { durationSeconds: n }); }}/> sec</span></label><label>Level <input aria-label={`Volume for ${clip.name}`} type="range" min="-30" max="-8" step="1" value={cue.volumeDb} disabled={locked} onChange={e => updateCue(cue.id, { volumeDb: Number(e.target.value) })}/><span>{cue.volumeDb} dB</span></label></div>
            <div className="soundtrack-credit"><a href={clip.sourceUrl} target="_blank" rel="noreferrer">{clip.artist} · CC0</a>{rendered && recorded && <button onClick={() => { stopPreview(); onListenAt(Math.max(0, rendered.startSeconds - 1)); }}><Headphones size={13}/>Hear in episode</button>}</div>
          </article>;
        })}</div>
        {draft.cues.length < 6 && <div className="soundtrack-add">{!draft.cues.some(c => c.kind === 'intro') && <button disabled={locked} onClick={() => add('intro')}><Plus size={14}/>Opening</button>}{!draft.cues.some(c => c.kind === 'outro') && <button disabled={locked} onClick={() => add('outro')}><Plus size={14}/>Closing</button>}{freeChapter > 0 && episode.narrationTiming !== 'episode' && <><button disabled={locked} onClick={() => add('transition')}><Plus size={14}/>Transition</button><button disabled={locked} onClick={() => add('ambience')}><Plus size={14}/>Ambience</button></>}</div>}
      </>}
      <div className="soundtrack-save"><div className="soundtrack-actions"><button className="button primary" disabled={locked || !dirty} onClick={() => void save(recorded)}>{busy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>} {recorded ? 'Apply to recording' : 'Save soundtrack'}</button><button className="button secondary" disabled={locked || !canPlan} onClick={() => void chooseAutomatically()}><Sparkles size={15}/>Choose sounds automatically</button></div><p className="field-hint">{recorded ? dirty ? 'Changes are ready to apply. The narration will be reused.' : 'Your saved soundtrack is included in this recording.' : 'Saved cues will be included when you generate audio.'}</p></div>
    </>}
    <details className="sound-library"><summary>Explore the sound library <span>{SOUND_LIBRARY.length} clips · included</span></summary><p>Three instrumental themes, matching transitions, and natural ambience. All clips are stored on this computer.</p><div className="sound-library-grid">{SOUND_LIBRARY.map(clip => <div key={clip.id}><button className="sound-library-play" aria-label={`Listen to ${clip.name}`} onClick={() => void listen(clip.id, `library-${clip.id}`)}>{preview === `library-${clip.id}` ? <Pause size={16}/> : <Play size={16}/>}</button><div><strong>{clip.name}</strong><small>{clip.kind} · {clip.seconds} sec</small><a href={clip.sourceUrl} target="_blank" rel="noreferrer">{clip.artist} · CC0</a></div></div>)}</div></details>
  </div>;
}
