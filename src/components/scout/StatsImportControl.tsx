import React, { useRef, useState } from 'react';
import { previewImport, commitImport, ImportPreview } from '../../services/statsImport';
import { downloadTeamStatsCsv } from '../../services/statsExport';
import { ScoutingData } from '../../types';

interface StatsImportControlProps {
  /** Called after a successful import so the shell can reload its rows. */
  onImported: () => void;
  /** The shell's already-loaded scouting rows, exported as the season backup. */
  rows: ScoutingData[];
}

/**
 * Stats-CSV import/export, lifted out of the retired Data Analysis screen.
 *
 * The Scout workspace replaced Data Analysis, but these were the only way
 * season data leaves and re-enters the app — so the controls move here rather
 * than disappearing with the screen. Import previews first; nothing is written
 * until the user confirms the team and row counts.
 */
export function StatsImportControl({ onImported, rows }: StatsImportControlProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setError(null);
    setResult(null);
    try {
      setPreview(previewImport(await file.text()));
    } catch (err: any) {
      setError(String(err?.message || err));
    }
  };

  const confirm = async () => {
    if (!preview) return;
    try {
      const { created, keptReal, synced, syncError } = await commitImport(preview.aggregates);
      setResult(
        `Imported ${preview.teams} teams — created ${created} reconstructed match rows, kept ${keptReal} real scouted rows. ` +
          (synced
            ? 'Synced to server.'
            : `Saved locally only — server sync failed (${syncError}). It will retry automatically.`)
      );
      onImported();
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setPreview(null);
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      <button className="pl-ghost-btn" onClick={() => fileRef.current?.click()}>
        Import stats CSV
      </button>
      <button
        className="pl-ghost-btn"
        onClick={() => {
          try {
            downloadTeamStatsCsv(rows);
          } catch (err: any) {
            setError(String(err?.message || err));
          }
        }}
      >
        Export stats CSV
      </button>

      {(error || result) && (
        <div className="cc-modal-backdrop" onClick={() => { setError(null); setResult(null); }}>
          <div className="cc-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{error ? 'IMPORT FAILED' : 'IMPORT COMPLETE'}</h3>
            <p>{error || result}</p>
            <div className="cc-modal-actions">
              <button
                className="cc-btn-primary"
                onClick={() => {
                  setError(null);
                  setResult(null);
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="cc-modal-backdrop">
          <div className="cc-modal" style={{ maxWidth: 520 }}>
            <h3>IMPORT TEAM STATS?</h3>
            <p>
              This will read <strong>{preview.teams} teams</strong> and create{' '}
              <strong>{preview.rowsToCreate} reconstructed match rows</strong>.
            </p>
            <div className="cc-banner info">
              The CSV holds per-team averages only. Per-match spreads are reconstructed from those
              averages, so distributions are indicative — the averages themselves are real. Every
              generated row is flagged as synthetic.
            </div>
            {preview.teamsWithoutSchedule.length > 0 && (
              <p>
                {preview.teamsWithoutSchedule.length} team(s) are not in the loaded match schedule
                and will be skipped: {preview.teamsWithoutSchedule.slice(0, 8).join(', ')}
                {preview.teamsWithoutSchedule.length > 8 ? '…' : ''}
              </p>
            )}
            <div className="cc-modal-actions">
              <button className="cc-btn-outline" onClick={() => setPreview(null)}>
                Cancel
              </button>
              <button className="cc-btn-grad" onClick={confirm}>
                Import
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
