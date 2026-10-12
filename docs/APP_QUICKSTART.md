# Scout 6560 — complete app guide

## 1. Sign-in, navigation and saving
Open **/frcScoutingAppV2/** (also **/app** on the combined server). Admin: **admin6560** with the team admin password. Scouts: enter the name registered under **Assign Scouters**; matching ignores case. A cookie remembers identity for up to a year, so reloads and ordinary Refresh/Sync keep you signed in. **Logout** clears that cookie without deleting scouting data. From Workspace or CV Tracker, use the existing **Admin/Back** control to reach Logout.

The admin menu contains **Assign Scouters**, **Select Matches**, **Scout Workspace**, **CV Tracker**, and **Livestream Worker**. Header **Sync** pushes pending scouting and retrieves server state; **Check** also checks server scouters; **Refresh** reloads data. The scout header shows their name and red/blue station assignment, with schedule/pit navigation, Refresh and Logout. **Activate & reload**, when shown, loads a waiting app update.

Scouting, timelines and scoreboard logs save locally and sync with configured Supabase. Local data supports offline use; confirm syncing before changing devices. Pick decisions and board Undo history are browser-local, shared across tabs, and **not synced to Supabase or separated by event**. Review/reset the board when changing events. An unfinished live tracking session does not resume after reload. Workspace tab, theme, comparison selections and unfinished branch construction are temporary.

## 2. Prepare the event
**Select Matches:** choose year, search/select the event, provide a TBA API key if required, and load the schedule. Queue the matches scouts should cover; inspect queued status, remove individual entries, or clear the queue. The selected event scopes match/scouting analysis.

**Assign Scouters:** add, edit or remove names; assign alliance and station 1–3; mark remote scouts; inspect the matches each scout completed. Station assignment determines the robot shown when a scout opens a match.

## 3. Match and pit scouting
**Match Schedule:** open a queued match, check its assigned team, and revisit existing scouting. Completion status considers saved timelines and older scouting records.

**Live Action Tracking:** start in sync with the match. Hold **Shooting**, **Passing**, **Contact Defense**, or **OOF** (out of order) while the robot performs that action; release when it stops. The clock shows auto/teleop and shifts, locking during the scoring delay. **End Match** finishes early if needed. Choose data confidence, review action totals and timestamped segments, **Export Timeline JSON** for a backup, then **Done**. Climb credit in fused analysis comes from available TBA score breakdowns.

**Pit Scouting:** select a scheduled team or add a team number/nickname manually. Record trench clearance; climb level and side/pillar/center positions; autonomous capability, climb and start locations; notes and photos. Camera and device upload add images; delete removes images; **Save** persists the form; **Reset** clears its inputs. Pit answers describe capabilities and do not directly become match scoring points.

## 4. Livestream and CV Tracker
**Livestream Worker:** enter the YouTube URL and event key, then **Start worker**. It waits/retries for the stream, detects a ticking match clock, and records alliance score changes. The menu shows status, captured count and recent activity. **Stop worker** stops monitoring. Browser close or Logout does not stop it; shutting down the server does.

| CV control | What it does |
|---|---|
| **Read Recording** | Scans a finished YouTube recording or a video path on the worker’s disk. Optional time limits restrict the scan. Download/cache choices trade disk space against repeated remote seeks. |
| **Watch Live** | Monitors incoming broadcast frames. One server capture runs at a time; cancel/stop it before starting another. Finished streams should use Read Recording. |
| **Upload File / Share Screen** | Provides browser footage for OCR. Screen sharing needs browser permission; choose the surface carrying the scoreboard. |
| **Calibrate Layout** | Uses sample frames to teach the event’s overlay location. Check red, blue and timer regions before trusting extraction. |
| **Auto-detect Regions / Reset Quad** | Finds or resets scoreboard boxes. Drag corners to fit the red/blue scores and timer; crop previews show OCR input. |
| **Start / Stop / Reset** | Controls browser OCR and clears the current capture when reset. |
| **Save / Export JSON / Import JSON** | Saves the current score log, exports a portable copy, or loads a prior log. Review match identification before saving. |

Inspect **Alliance Score Over Time**, **Per-Second Log**, worker progress, uploaded scoreboard logs and **Needs Review**. Select a match/capture to inspect it. Video time locates the frame in its source; match time aligns score changes with robot timelines. Live monitoring collects incoming data; recording analysis processes replay frames. Quality is an internal consistency indicator, not an accuracy percentage. Review flagged or incomplete reads. Without a schedule/worker TBA key, captures may remain unidentified locally and cannot automatically attach to a match cloud row.

## 5. Scout Workspace
Set **our team** in the header. Tabs share one loaded dataset. Fused timeline + scoreboard data takes priority per robot/match; ordinary scouting and imported rows provide fallback. **BPS** means estimated points per second. Timeline-only or scoreboard-only data cannot isolate each robot’s fuel contribution. Source badges distinguish BPS, legacy and mixed data; reconstructed CSV rows are labeled.

| Feature | Controls and meaning |
|---|---|
| **Field Ranking** | Scores teams by adjusted average above the draggable **Defense line**; below it, ranks estimated points denied. Bands show normal floor–ceiling, markers show median, and dots show observed/missing matches and deaths. Click a team number to open details. |
| **Team details** | Shows averages, median/IQR, normal range, auto/teleop/climb, reliability, outliers and match charts. Solved teams also show BPS, solver coverage, action-time shares and estimated passing output. **Jump to** opens another team; **All teams** returns. |
| **+** | Toggles the team’s first-pick shortlist membership. Shortlisted teams sort earlier within their existing Picklist shelf. Adding a team removes its explicit DNP flag. |
| **‖** | Selects a comparison team. Open another team and press ‖ again to show a browser dialog comparing scoring, climb, consistency, coverage and source. Press again on a selected team to remove it. |
| **×** in team details | Toggles your explicit do-not-pick flag and removes that team from shortlists. Press again to restore eligibility. |
| **Match Strategy** | Choose one of our scheduled matches; compare our 25th-percentile scoring with opponents’ 75th-percentile scoring, robot roles, fuel-target estimate and available BPS cross-checks. Click robots for details. |
| **Rank Forecast** | Select Rough/Expected/Optimistic to simulate scheduled qualifications using floor/average/ceiling. Inspect estimated seed, total RP, ranking score and match count; click teams for details. Uses configured regional scoring thresholds, not live official standings. |
| **CSV import/export** | Import previews team/row counts before confirmation and preserves real scouting. Export downloads scouting aggregates. Imported averages reconstruct illustrative match spreads; CSV is not a backup of timelines, OCR logs or draft decisions. |
| **Dark/Light mode; Admin** | Switches workspace appearance or returns to the admin menu. |

Missing teams contribute no measured scoring; incomplete coverage can distort forecasts and draft estimates. Defense denial and passing fuel are estimates. Few observed matches or reconstructed spreads provide weak evidence about consistency.

CSV import saves locally first. If cloud confirmation takes more than eight seconds, the result reports local-only saving and the normal sync queue continues retrying; do not repeatedly import to force a sync.

### How scouts and the live worker work together
Use the **same event and exact match** on every device. Each of the three alliance scouts starts their local clock at the match start they are watching, holds **Shooting** for each shooting stretch, then finishes/saves the timeline. The worker independently timestamps scoreboard changes from the broadcast clock. Livestream delivery delay and YouTube playback position do not become robot shooting time: both streams are joined by **match key + alliance + elapsed match seconds**.

Saved timelines attempt an immediate Supabase upload; failed uploads retry every 15 seconds while the app is open and on reconnect. The open Workspace polls for new timelines and worker captures every 15 seconds without a reload. Completed worker captures can also load directly from the combined server when its cloud upload fails. This is **post-match analysis**, not live transmission of a scout's unfinished button presses. Devices must reach the same Supabase project to share scout timelines; locally saved timelines survive outages, but another device cannot see them until uploaded.

The statistical solver estimates scoring rates and small individual scout timing corrections, allowing for ball flight and scoreboard delay. Each accepted positive score change is then split between plausible shooters using their activity and fitted rates. Solo shooting has clearer attribution; simultaneous shooting is an estimate. Delayed auto updates during the three-second handoff remain auto. Workspace team/match scores use these observed allocations rather than simply multiplying shooting duration by a rate.

All three robot timelines must be present and complete for that alliance before attribution is used. Unknown shooters, unmatched/flagged captures and rejected OCR reads do not become guessed team points. Unexplained positive score remains unassigned. The underlying attribution report retains each elapsed second, observed change, team shares, ambiguity and unassigned remainder. Allocation shares sum to the observed change; final displayed fuel estimates may additionally be calibrated to TBA's fuel total, with robot tower credit added separately. Unassigned points are never redistributed upward through that calibration.

**Limits:** an alliance score overlay does not identify individual balls, fouls or climbs. A foul/climb arriving while a robot shoots can still contaminate the split before official fuel/tower breakdowns arrive. Overlapping shooters with indistinguishable activity cannot be uniquely separated. These are estimates supported by scouting and OCR, not verified individual fuel counts. Re-scout/correct the source timeline or CV capture to recompute results; no visual workflow changes are required.

## 6. Picklist → Alliance Selection
1. **Build branches:** on Picklist, tap a card for the first-pick target, then tap second-pick alternatives in priority order. Tap again to remove an option; tapping the first target clears that branch. **Clear** abandons the scratch plan; **Save branch** stores it once both stages exist. Our team, already-seated teams and explicitly DNP teams cannot enter a new plan.
2. **Read shelves:** existing categories are automatic point-distribution bands. **DO NOT PICK includes the lowest scoring quarter as well as explicit × decisions**; that heading alone does not prove your scouts rejected a robot. Unscouted teams have a separate shelf.
3. **Prepare captains:** Alliance Selection uses official TBA standings if available, otherwise scouting order. Captain placeholders promote as lower captains are drafted. Type actual captains into the editable board when the fallback disagrees with event standings.
4. **Log picks:** tap an available team to place it on the highlighted alliance, normally A1→A8 for first picks and A8→A1 for second picks. A captain cannot select itself or a committed/higher captain. Alternatively edit exact captain/first/second cells: Enter commits once, Escape cancels, blank clears; fill first before second. Reassigning teams removes duplicates; editing two existing picks swaps their seats.
5. **Correct mistakes:** **Undo** restores the actual last board edit, including after reload (up to 100 edits). **Reset** clears the board while preserving saved branches/shortlists; Reset itself is undoable.
6. **Use branches:** taken teams are crossed out; the first remaining second option is highlighted. Tap a free second option to promote it; branch **×** deletes the branch. Auto/teleop/climb breakdowns and the alliance estimate help compare plans.
7. **Call on/off:** shows/hides accept-versus-decline advice. Both sides simulate the remaining draft; a decline prevents subsequent invitations but permits captaincy, consistent with [FIRST’s 2026 rules §10.6.1](https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm). Close gaps are toss-ups. These are weighted scoring/defense/climb heuristics, not calibrated win probabilities. Opponent choices, invitation declines and timing violations still require operator judgment/manual board corrections.

## 7. Recovery and event close
Use ordinary Refresh/Sync first. **Force refresh · clear caches** is a recovery action that clears local site data and reloads; the identity cookie remains, but browser-local pick decisions or unsynced records may be lost. Clearing browser cookies removes sign-in too.

Before leaving: verify coverage, review flagged/unidentified captures, export required CSV/timeline/CV backups, confirm sync, and stop the worker when monitoring is finished.
