import * as c from '../shared/contracts/index.js';
import * as f from '../shared/fixtures/index.js';
import { ApiFailure, request, upload } from './api.js';
import { escape as e, label, date, badge, evidence } from './view.js';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
let live = localStorage.getItem('ria-mode') !== 'fixture';
let screen: 'repository' | 'sources' | 'upload' | 'detail' = 'repository';
let sources: c.SourceConfig[] = [];
let publication: c.PublicationDetail | undefined;
let comparison: c.Comparison | undefined;
let page = 1;
let query = new URLSearchParams();
let recovery: { publication: c.PublicationDetail; referenceId: string } | undefined;
let generation = 0;
let pollController = new AbortController();
const jobs = new Map<string, c.JobStatus>();
const monitorRuns = new Map<string, c.MonitorRunResult>();
const scenarios = { completed: f.publicationFixture, missing: f.missingPredecessorPublicationFixture, ambiguous: f.ambiguousPublicationFixture, failed: f.extractionFailedPublicationFixture, queued: f.queuedPublicationFixture };
let scenario: keyof typeof scenarios = 'completed';
const options = (values: readonly string[], selected = '') => values.map(value => `<option value="${e(value)}" ${selected === value ? 'selected' : ''}>${e(label(value))}</option>`).join('');
const input = (name: string, title: string, type = 'text', value = '', required = false) => `<label>${title}<input name="${name}" type="${type}" value="${e(value)}" ${required ? 'required' : ''}></label>`;
const select = (name: string, title: string, values: readonly string[], selected = '', all = true) => `<label>${title}<select name="${name}">${all ? '<option value="">All</option>' : ''}${options(values, selected)}</select></label>`;
const params = (publicationId: string) => ({ publicationId });

function shell() {
  root.innerHTML = `<aside><a class="brand" href="#repository"><span class="brand-icon">R</span> REGULENS<span class="level">LEVEL 1</span></a><div class="workspace">REGULATORY WORKSPACE</div><nav><a href="#repository" ${screen === 'repository' || screen === 'detail' ? 'aria-current="page"' : ''}>▤ <span>Publication repository</span></a><a href="#sources" ${screen === 'sources' ? 'aria-current="page"' : ''}>◎ <span>Sources & monitoring</span></a><a href="#upload" ${screen === 'upload' ? 'aria-current="page"' : ''}>↥ <span>Upload publication</span></a></nav><div class="aside-foot"><span class="dot"></span> Traceable regulatory intelligence<p>Discover. Understand. Compare.</p></div></aside><div class="workspace-body"><header><span>Regulatory intelligence <b>/ ${screen === 'detail' ? 'Publication detail' : label(screen)}</b></span><label class="mode-control">Data mode <select id="mode"><option value="fixture" ${!live ? 'selected' : ''}>Synthetic fixtures</option><option value="live" ${live ? 'selected' : ''}>Live API</option></select></label></header><div class="mode-banner">${live ? 'LIVE API · Requests use /api/v1. Backend availability is required.' : 'SYNTHETIC DEMO · Invented publications and example.org sources. No monitoring, uploads or reviews are persisted.'}</div><div id="notice" role="status" aria-live="polite"></div><main id="content"><p class="loading">Loading…</p></main><section id="jobs" aria-live="polite"></section></div>`;
  document.querySelector<HTMLSelectElement>('#mode')!.onchange = event => {
    live = (event.target as HTMLSelectElement).value === 'live'; localStorage.setItem('ria-mode', live ? 'live' : 'fixture');
    pollController.abort(); pollController = new AbortController(); jobs.clear(); monitorRuns.clear(); recovery = undefined; publication = undefined; navigate();
  };
  renderJobs();
}
function notify(message: string, error = false) {
  const notice = document.querySelector('#notice');
  if (notice) { notice.className = error ? 'notice error' : 'notice'; notice.textContent = message; }
}
function failure(error: unknown) { notify(error instanceof Error ? error.message : 'Operation failed.', true); }
function content(html: string) { document.querySelector('#content')!.innerHTML = html; }
function title(kicker: string, heading: string, description: string, actions = '') { return `<div class="page-title"><div><p class="eyebrow">${kicker}</p><h1>${heading}</h1><p class="muted">${description}</p></div><div class="actions">${actions}</div></div>`; }
async function action(button: HTMLButtonElement, callback: () => Promise<void>) {
  button.disabled = true;
  try { await callback(); } catch (error) { failure(error); } finally { button.disabled = false; }
}
function renderJobs() {
  const container = document.querySelector('#jobs'); if (!container) return;
  container.innerHTML = jobs.size ? `<h2>Operation activity</h2>${[...jobs.values()].map(job => `<article class="job"><div><strong>${e(label(job.kind))}</strong> ${badge(job.state)} <span class="mono">${e(job.id)}</span></div>${job.error ? `<p class="error-text">${e(job.error.message)}</p>` : ''}${job.result?.kind === 'monitor' ? `<p>Source outcome: ${badge(job.result.monitorRun.outcome)} · Discovery complete; ingestion jobs are tracked separately.</p>` : ''}${job.result?.kind === 'ingestion' ? `<a href="#publication/${job.result.publication.id}">Open processed publication →</a>` : ''}</article>`).join('')}` : '';
}
async function track(jobId: string): Promise<c.JobStatus> {
  const signal = pollController.signal;
  for (;;) {
    if (signal.aborted) throw new DOMException('Operation cancelled', 'AbortError');
    let job: c.JobStatus;
    try { job = await request(c.API_CONTRACT.readJob, c.JobStatusSchema, { params: { jobId }, signal }); }
    catch (error) {
      if (error instanceof ApiFailure && error.status === 429) { await pause(error.retryAfter * 1000, signal); continue; }
      throw error;
    }
    jobs.set(jobId, job); renderJobs();
    if (job.state !== 'queued' && job.state !== 'running') return job;
    await pause(1800, signal);
  }
}
function pause(ms: number, signal: AbortSignal) { return new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(new DOMException('Operation cancelled', 'AbortError')); }; const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms); signal.addEventListener('abort', abort, { once: true }); }); }
async function getSources() {
  if (!live) { sources = f.sourcesFixture.items; return; }
  const items: c.SourceConfig[] = [];
  for (let sourcePage = 1; ; sourcePage++) {
    const result = await request(c.API_CONTRACT.listSources, c.SourceListResponseSchema, { query: new URLSearchParams({ page: String(sourcePage), pageSize: '100' }) });
    items.push(...result.items); if (!result.hasNextPage) break;
  }
  sources = items;
}
function fixtureSearch(search: URLSearchParams) {
  const filter = c.parsePublicationSearchParams(search);
  const detail = scenarios[scenario];
  const matches = (!filter.q || [detail.title, detail.referenceNumber, detail.summary, ...detail.obligations.map(o => o.text)].join(' ').toLowerCase().includes(filter.q.toLowerCase()))
    && (!filter.country || filter.country.includes(detail.country)) && (!filter.regulatorId || filter.regulatorId.includes(detail.regulatorId))
    && (!filter.businessArea || filter.businessArea.some(area => detail.businessAreas.includes(area))) && (!filter.changeClass || filter.changeClass.some(cls => detail.changeClasses.includes(cls)))
    && (!filter.processingState || filter.processingState === detail.processingState) && (!filter.reviewState || filter.reviewState === detail.review.state)
    && (!filter.relationshipState || filter.relationshipState === detail.relationshipState)
    && (!filter.publicationDateFrom || !!detail.publicationDate && detail.publicationDate.slice(0, 10) >= filter.publicationDateFrom)
    && (!filter.publicationDateTo || !!detail.publicationDate && detail.publicationDate.slice(0, 10) <= filter.publicationDateTo);
  const summary = c.PublicationSummarySchema.parse(Object.fromEntries(Object.keys(c.PublicationSummarySchema.shape).map(key => [key, detail[key as keyof c.PublicationDetail]])));
  return c.PublicationListResponseSchema.parse({ items: matches && page === 1 ? [summary] : [], page, pageSize: 20, total: matches ? 1 : 0, hasNextPage: false });
}
async function repository(token: number) {
  await getSources();
  query.set('page', String(page)); query.set('pageSize', '20');
  const result = live ? await request(c.API_CONTRACT.searchPublications, c.PublicationListResponseSchema, { query }) : fixtureSearch(query);
  if (token !== generation) return;
  content(title('PUBLICATION REPOSITORY', 'Regulatory developments', 'Discover publications, inspect cited requirements, and understand what changed.', '<a class="button primary" href="#upload">＋ Upload publication</a>') +
    `<div class="stats"><div><span>FILTERED PUBLICATIONS</span><strong>${result.total}</strong></div><div><span>CONFIGURED SOURCES</span><strong>${sources.length}</strong></div><div><span>REGIONS IN SOURCE CATALOG</span><strong>${new Set(sources.map(s => s.region)).size}<small> / 4</small></strong></div></div>
    ${!live ? `<div class="scenario"><label>Preview a contract scenario <select id="scenario">${options(Object.keys(scenarios), scenario)}</select></label><span class="muted">Each scenario is an alternate fixture for the same publication.</span></div>` : ''}
    <form id="filters" class="panel filters"><label class="search">Search publications<input name="q" type="search" maxlength="200" value="${e(query.get('q'))}" placeholder="Title, reference number or extracted text"></label>
    ${select('country', 'Country', [...new Set(sources.map(s => s.country))], query.get('country') ?? '')}
    <label>Regulator<select name="regulatorId"><option value="">All</option>${[...new Map(sources.map(s => [s.regulatorId, s])).values()].map(s => `<option value="${s.regulatorId}" ${query.get('regulatorId') === s.regulatorId ? 'selected' : ''}>${e(s.regulatorName)}</option>`).join('')}</select></label>
    ${select('businessArea', 'Business area', c.BusinessAreaSchema.options, query.get('businessArea') ?? '')}${select('changeClass', 'Change classification', c.ChangeClassSchema.options, query.get('changeClass') ?? '')}
    ${input('publicationDateFrom', 'Published from', 'date', query.get('publicationDateFrom') ?? '')}${input('publicationDateTo', 'Published through', 'date', query.get('publicationDateTo') ?? '')}
    ${select('processingState', 'Processing', c.ProcessingStateSchema.options, query.get('processingState') ?? '')}${select('reviewState', 'Review', c.ReviewStateSchema.options, query.get('reviewState') ?? '')}${select('relationshipState', 'Relationship', c.RelationshipStateSchema.options, query.get('relationshipState') ?? '')}
    <div class="filter-actions"><button class="primary">Apply filters</button><button type="button" id="reset">Clear</button></div></form>
    <div class="panel table-scroll"><table><thead><tr><th>Publication</th><th>Published</th><th>Processing</th><th>Human review</th><th>Historical relationship</th><th>Comparison outcome</th></tr></thead><tbody>${result.items.map(p => `<tr><td><a class="publication-title" href="#publication/${p.id}">${e(p.title)}</a><p class="muted">${e(p.regulatorName)} · ${e(p.country)}</p><span class="mono">${e(p.referenceNumber ?? 'Reference unknown')}</span> · ${badge(p.kind)}${p.kind === 'consultation' ? '<p class="warning-text">Proposed requirements · consultation</p>' : ''}<p class="muted">Discovered ${e(date(p.discoveredAt))}</p></td><td>${e(date(p.publicationDate))}</td><td>${badge(p.processingState)}${p.processingError ? `<p class="error-text">${e(p.processingError.message)}</p>` : ''}</td><td>${badge(p.review.state)}</td><td>${badge(p.relationshipState)}</td><td>${p.changeClasses.length ? p.changeClasses.map(badge).join(' ') : '<span class="muted">No completed classification</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No publications match these filters.</td></tr>'}</tbody></table></div>
    <div class="pagination"><span>${result.total} result${result.total === 1 ? '' : 's'} · Page ${page}</span><div><button id="previous" ${page === 1 ? 'disabled' : ''}>← Previous</button><button id="next" ${!result.hasNextPage ? 'disabled' : ''}>Next →</button></div></div>`);
  document.querySelector<HTMLFormElement>('#filters')!.onsubmit = event => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const next = new URLSearchParams(); for (const [key, value] of new FormData(form)) if (String(value).trim()) next.append(key, String(value).trim()); try { c.parsePublicationSearchParams(next); query = next; page = 1; void navigate(); } catch (error) { failure(error); } };
  document.querySelector('#reset')!.addEventListener('click', () => { query = new URLSearchParams(); page = 1; void navigate(); });
  document.querySelector('#previous')!.addEventListener('click', () => { page--; void navigate(); }); document.querySelector('#next')!.addEventListener('click', () => { page++; void navigate(); });
  document.querySelector<HTMLSelectElement>('#scenario')?.addEventListener('change', event => { scenario = (event.target as HTMLSelectElement).value as keyof typeof scenarios; page = 1; void navigate(); });
}

async function sourceScreen(token: number) {
  await getSources(); if (token !== generation) return;
  content(title('SOURCE OPERATIONS', 'Sources & monitoring', 'Configure frequency and follow actual outcomes for each regional source.', `<button id="run-all" class="primary" ${!live ? 'disabled' : ''}>Run enabled sources</button>`) +
    `<p class="muted">Last attempt includes failed runs. Last success and current errors are available only for runs observed in this session; source history is not exposed by the contract.</p><div class="source-grid">${sources.map(source => {
      const run = [...monitorRuns.values()].reverse().find(r => r.sources.some(s => s.sourceId === source.id)); const outcome = run?.sources.find(s => s.sourceId === source.id);
      const lastSuccess = [...monitorRuns.values()].reverse().find(r => r.sources.some(s => s.sourceId === source.id && s.state === 'succeeded'));
      return `<article class="panel source"><div class="source-top"><span class="country">${source.country}</span>${badge(outcome?.state ?? (source.lastMonitoredAt ? 'History unavailable' : 'Never run'))}</div><h2>${e(source.name)}</h2><p>${e(source.regulatorName)} · ${e(label(source.region))}</p><a href="${e(source.url)}" target="_blank" rel="noopener noreferrer">Official source ↗</a><dl><dt>Last attempt</dt><dd>${e(date(run?.completedAt ?? source.lastMonitoredAt))}</dd><dt>Last successful run</dt><dd>${lastSuccess ? e(date(lastSuccess.completedAt)) : 'Not available'}</dd><dt>Next scheduled run</dt><dd>${source.nextMonitorAt ? e(date(source.nextMonitorAt)) : source.enabled ? 'Not scheduled' : 'Disabled'}</dd></dl>${outcome ? `<p>Found <b>${outcome.publicationsFound}</b> · New <b>${outcome.discoveredPublications.length}</b> · Already known <b>${outcome.alreadyKnownCount}</b> · Failed source <b>${outcome.state === 'failed' ? 1 : 0}</b></p>${outcome.error ? `<p class="error-text">${e(outcome.error.message)}</p>` : ''}` : ''}<form data-source="${source.id}"><label class="checkbox"><input type="checkbox" name="enabled" ${source.enabled ? 'checked' : ''} ${!live ? 'disabled' : ''}> Monitoring enabled</label>${input('monitoringIntervalMinutes', 'Frequency in minutes (15–43,200)', 'number', String(source.monitoringIntervalMinutes), true)}<div class="actions"><button ${!live ? 'disabled' : ''}>Save configuration</button><button type="button" data-run="${source.id}" ${!live || !source.enabled ? 'disabled' : ''}>Run now →</button></div></form></article>`;
    }).join('')}</div>${!live ? '<div class="panel preview"><h2>Inspect fixture run outcomes</h2><p>Static contract examples; these do not run monitoring.</p><button data-preview="success">Successful</button> <button data-preview="partial">Partial failure</button> <button data-preview="failure">All sources failed</button></div>' : ''}`);
  document.querySelector<HTMLButtonElement>('#run-all')!.onclick = event => void action(event.currentTarget as HTMLButtonElement, () => monitor());
  document.querySelectorAll<HTMLButtonElement>('[data-run]').forEach(button => button.onclick = () => void action(button, () => monitor(button.dataset.run)));
  document.querySelectorAll<HTMLFormElement>('[data-source]').forEach(form => form.onsubmit = event => { event.preventDefault(); void action(form.querySelector('button')!, async () => {
    const data = new FormData(form); const body = c.SourceUpdateRequestSchema.parse({ enabled: data.has('enabled'), monitoringIntervalMinutes: Number(data.get('monitoringIntervalMinutes')) });
    await request(c.API_CONTRACT.updateSource, c.SourceConfigSchema, { params: { sourceId: form.dataset.source! }, body }); await navigate(); notify('Source configuration saved by the backend.');
  }); });
  document.querySelectorAll<HTMLButtonElement>('[data-preview]').forEach(button => button.onclick = () => { const job = button.dataset.preview === 'success' ? f.monitorJobFixture : button.dataset.preview === 'partial' ? f.partialMonitorJobFixture : f.failedMonitorJobFixture; jobs.set(job.id, job); if (job.result?.kind === 'monitor') monitorRuns.set(job.id, job.result.monitorRun); void navigate(); });
}
async function monitor(sourceId?: string) {
  const body = c.MonitorRequestSchema.parse(sourceId ? { sourceIds: [sourceId] } : {});
  const accepted = await request(c.API_CONTRACT.triggerMonitor, c.MonitorAcceptedResponseSchema, { body }); notify(`Monitoring accepted · queued job ${accepted.jobId}`);
  const job = await track(accepted.jobId);
  if (job.result?.kind === 'monitor') {
    const result = await request(c.API_CONTRACT.readMonitorResult, c.MonitorRunResultSchema, { params: { jobId: job.id } }); monitorRuns.set(job.id, result);
    for (const id of result.sources.flatMap(s => s.ingestionJobIds)) void track(id).catch(failure);
  }
  if (screen === 'sources' || screen === 'repository') await navigate();
  notify(job.error?.message ?? 'Monitoring finished. Inspect source outcomes and separate ingestion jobs.', job.state === 'failed');
}

async function detailScreen(id: string, token: number) {
  if (!live && id !== f.fixtureIds.publication) throw new Error('This predecessor is referenced by the synthetic fixture, but its publication detail is not supplied. Return to the repository to inspect the current publication.');
  const current = live ? await request(c.API_CONTRACT.readPublication, c.PublicationDetailSchema, { params: params(id) }) : scenarios[scenario];
  let structuredPending = false;
  if (live && current.processingState === 'succeeded') {
    try {
      const structured = await request(c.API_CONTRACT.readObligations, c.PublicationObligationsResponseSchema, { params: params(id) });
      if (structured.versionId === current.currentVersionId) current.obligations = structured.obligations;
      else structuredPending = true;
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 409) structuredPending = true;
      else throw error;
    }
  }
  const result = current.latestComparisonId ? live ? await request(c.API_CONTRACT.readComparison, c.ComparisonSchema, { params: { comparisonId: current.latestComparisonId } }) : scenario === 'missing' || scenario === 'ambiguous' ? undefined : f.comparisonFixture : undefined;
  if (token !== generation) return; publication = current; comparison = result;
  content(`<a href="#repository" class="back">← Publication repository</a>` + title('PUBLICATION DETAIL', e(current.title), `${e(current.regulatorName)} · ${current.country}`, '<button id="refresh">↻ Refresh</button>') +
    `<div class="state-strip"><div>Processing ${badge(current.processingState)}</div><div>Human review ${badge(current.review.state)}</div><div>Historical relationship ${badge(current.relationshipState)}</div></div>
    ${current.kind === 'consultation' ? '<div class="notice">Consultation · proposed requirements. Do not treat these as binding obligations.</div>' : ''}
    <section class="panel"><div class="section-heading"><h2>Publication overview</h2>${badge(current.kind)}</div><p>${e(current.summary ?? 'Extracted summary is not available.')}</p><dl class="metadata"><div><dt>Reference</dt><dd>${e(current.referenceNumber ?? 'Unknown')}</dd></div><div><dt>Publication date</dt><dd>${e(date(current.publicationDate))}</dd></div><div><dt>Effective date</dt><dd>${e(date(current.effectiveDate))}</dd></div><div><dt>Business areas</dt><dd>${current.businessAreas.map(v => e(label(v))).join(', ') || 'Not extracted'}</dd></div></dl>${current.sourceUrl ? `<a href="${e(current.sourceUrl)}" target="_blank" rel="noopener noreferrer">Official publication ↗</a>` : '<p class="muted">No public source URL supplied. Original-file download requires a backend access endpoint.</p>'}<details><summary>Document versions & identifiers</summary>${current.versions.map(v => `<p><b>Version ${v.versionNumber}${v.id === current.currentVersionId ? ' · current' : ''}</b> · ${e(v.fileName)} · ${badge(v.processingState)}<br><span class="mono">Document ${v.documentId}<br>Version ${v.id}</span>${v.sourceUrl ? `<br><a href="${e(v.sourceUrl)}" target="_blank" rel="noopener noreferrer">Original public source ↗</a>` : ''}</p>`).join('')}</details></section>
    ${current.processingError ? `<section class="panel error"><h2>Extraction failed</h2><p>${e(current.processingError.message)}</p><p>No successful obligations result is available. Upload a readable replacement; an ingestion retry endpoint is not defined.</p><a class="button" href="#upload">Upload readable document</a></section>` : current.processingState !== 'succeeded' || structuredPending ? `<section class="panel"><h2>${structuredPending ? 'Structured analysis pending' : 'Extraction ' + e(current.processingState)}</h2><p>Obligations and evidence will appear after successful processing.</p></section>` : `<section><h2>Structured obligations <span class="count">${current.obligations.length}</span></h2>${current.obligations.map(o => `<article class="panel obligation"><h3>${e(o.text)}</h3><div class="obligation-grid"><div><h4>Applicability</h4><p>Entities: ${e(o.applicableEntities.join(', ') || 'Not specified')}</p><p>Departments: ${e(o.departments.join(', ') || 'Not specified')}</p><p>Activities: ${e(o.regulatedActivities.join(', ') || 'Not specified')}</p><p>Business areas: ${e(o.businessAreas.map(label).join(', '))}</p></div><div><h4>Dates</h4><p>Compliance deadline: <b>${e(date(o.complianceDeadline))}</b></p><p>Effective: ${e(date(o.effectiveDate))}</p></div></div><h4>Supporting source evidence</h4>${o.evidence.map(v => evidence(v)).join('')}</article>`).join('') || '<div class="panel">Extraction succeeded; no obligations were identified.</div>'}</section>`}
    <section class="panel"><h2>References & predecessor relationships</h2>${current.references.map(ref => `<article class="reference"><h3>${e(ref.referenceText)} ${badge(ref.resolution)}</h3><p>${e(label(ref.relation))} · ${e(ref.referenceNumber ?? 'No reference number')}</p>${ref.resolution === 'resolved' ? `<a href="#publication/${ref.targetPublicationId}">Open referenced publication →</a><p class="mono">Version ${ref.targetVersionId}</p>` : `<p>${e(ref.reason)}</p>${ref.resolution === 'ambiguous' ? `<p class="mono">Candidates: ${ref.candidatePublicationIds.map(e).join(', ')}</p>` : ''}${ref.relation !== 'cites' ? `<button data-recover="${ref.id}">Upload missing predecessor</button>` : ''}`}${ref.evidence.map(v => evidence(v)).join('')}</article>`).join('') || '<p class="muted">No extracted references available.</p>'}</section>
    <section class="panel"><div class="section-heading"><h2>Historical comparison</h2><button id="compare" ${!live || structuredPending || current.processingState !== 'succeeded' ? 'disabled' : ''}>Run comparison</button></div>${current.relationshipState === 'missingPredecessor' || current.relationshipState === 'ambiguous' ? '<div class="notice">Historical relationship unresolved. Supply or select the intended predecessor; no change classification has been inferred.</div>' : ''}<div id="comparison">${comparisonMarkup(comparison)}</div>
    ${live && current.references.some(r => r.relation !== 'cites') ? `<details><summary>Link an existing predecessor and rerun</summary><form id="link-form" class="form-grid"><label>Reference<select name="referenceId">${current.references.filter(r => r.relation !== 'cites').map(r => `<option value="${r.id}">${e(r.referenceText)}</option>`).join('')}</select></label>${input('predecessorPublicationId', 'Stored predecessor publication UUID', 'text', '', true)}${input('predecessorVersionId', 'Stored predecessor version UUID', 'text', '', true)}<button>Link & compare</button></form></details>` : ''}
    ${!live ? `<details><summary>Inspect all six classification examples (independent fixtures)</summary><p class="muted">These are separate examples, not classifications attached to this publication.</p>${f.changeFixtures.map(changeMarkup).join('')}</details>` : ''}</section>
    <section class="panel"><h2>Human review</h2><p class="muted">Review is separate from extraction and comparison outcomes. Updates use the review timestamp to prevent stale approvals.</p><form id="review-form" class="form-grid">${select('state', 'Review state', c.ReviewStateSchema.options, current.review.state, false)}<label>Review note<textarea name="note" maxlength="4000">${e(current.review.note)}</textarea></label><button ${!live ? 'disabled' : ''}>Save review</button></form><p class="muted">Last review update: ${e(date(current.review.updatedAt))}</p></section>`);
  document.querySelector('#refresh')!.addEventListener('click', () => void navigate());
  document.querySelectorAll<HTMLButtonElement>('[data-recover]').forEach(button => button.onclick = () => { recovery = { publication: current, referenceId: button.dataset.recover! }; location.hash = 'upload'; });
  document.querySelector<HTMLButtonElement>('#compare')!.onclick = event => void action(event.currentTarget as HTMLButtonElement, async () => {
    const body = c.ComparisonRequestSchema.parse({ currentVersionId: current.currentVersionId, predecessorVersionId: null });
    const accepted = await request(c.API_CONTRACT.requestComparison, c.ComparisonAcceptedResponseSchema, { params: params(current.id), body }); await completeComparison(accepted);
  });
  document.querySelector<HTMLFormElement>('#link-form')?.addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; void action(form.querySelector('button')!, async () => {
    const body = c.PredecessorLinkRequestSchema.parse({ ...Object.fromEntries(new FormData(form)), currentVersionId: current.currentVersionId });
    const accepted = await request(c.API_CONTRACT.linkPredecessor, c.ComparisonAcceptedResponseSchema, { params: params(current.id), body }); await completeComparison(accepted);
  }); });
  document.querySelector<HTMLFormElement>('#review-form')!.onsubmit = event => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; void action(form.querySelector('button')!, async () => {
    const data = new FormData(form); const body = c.ReviewUpdateRequestSchema.parse({ state: data.get('state'), note: String(data.get('note')).trim() || null, expectedUpdatedAt: current.review.updatedAt });
    try { await request(c.API_CONTRACT.updateReview, c.ReviewRecordSchema, { params: params(current.id), body }); await navigate(); notify('Review saved by the backend.'); }
    catch (error) { if (error instanceof ApiFailure && error.status === 409) { await navigate(); notify('Review could not be saved. The current publication has been reloaded; reconcile the review and submit again. Nothing was replayed.', true); } else throw error; }
  }); };
  if (live && (structuredPending || current.processingState === 'queued' || current.processingState === 'processing' || result?.state === 'queued' || result?.state === 'processing')) {
    void pause(2000, pollController.signal).then(() => { if (token === generation) void navigate(); }).catch(() => {});
  }
}
function changeMarkup(change: c.ChangeItem) { return `<article class="change"><h3>${badge(change.classification)}${change.classification === 'deadlineChanged' ? ` <span>${e(label(change.deadlineDirection))}: ${e(date(change.previousDeadline))} → ${e(date(change.updatedDeadline))}</span>` : ''}</h3><p>${e(change.explanation)}</p><div class="clause-grid"><div><h4>PREVIOUS CLAUSE</h4>${evidence(change.before, change.after, 'before')}</div><div><h4>UPDATED CLAUSE</h4>${evidence(change.after, change.before)}</div></div></article>`; }
function comparisonMarkup(value?: c.Comparison) {
  if (!value) return '<p class="muted">No comparison loaded. No material change is reported only when explicitly returned by a successful comparison.</p>';
  return `${badge(value.state)}<dl><dt>Previous document / version</dt><dd class="mono">${e(value.predecessorDocumentId ?? 'Not established')}<br>${e(value.predecessorVersionId ?? 'Not established')}</dd><dt>Current document / version</dt><dd class="mono">${value.currentDocumentId}<br>${value.currentVersionId}</dd></dl>${value.issue ? `<p class="error-text">${e(value.issue.message)}</p>` : ''}${value.state === 'queued' || value.state === 'processing' ? '<p>Comparison is in progress. Refresh to read the latest outcome.</p>' : ''}${value.changes.map(changeMarkup).join('')}`;
}
async function completeComparison(accepted: ReturnType<typeof c.ComparisonAcceptedResponseSchema.parse>) {
  notify(`Comparison accepted · queued job ${accepted.jobId}`);
  const job = await track(accepted.jobId);
  if (screen === 'detail' && publication?.id === accepted.publicationId) await navigate();
  notify(job.error?.message ?? 'Comparison finished. Inspect the returned outcome.', job.state === 'blocked' || job.state === 'failed');
}

async function uploadScreen(token: number) {
  await getSources(); if (token !== generation) return;
  content(title('DOCUMENT INGESTION', recovery ? 'Supply a missing predecessor' : 'Upload a publication', 'PDF, DOCX or plain text · maximum 20 MiB · one document at a time') +
    `${recovery ? `<div class="notice">Recovery for ${e(recovery.publication.title)}. The upload must extract successfully before it can be linked. <button id="cancel-recovery">Cancel recovery</button></div>` : ''}<section class="panel upload-panel"><form id="upload-form"><label class="file-drop"><span class="upload-icon">↥</span><strong>Select a regulatory publication</strong><span>PDF, DOCX or TXT · up to 20 MiB</span><input name="file" type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" required></label><div class="form-grid">${input('title', 'Publication title', 'text', '', true)}<label>Issuing source / regulator<select name="sourceId" required><option value="">Select a configured source</option>${sources.map(s => `<option value="${s.id}">${e(s.regulatorName)} · ${s.country}</option>`).join('')}</select></label>${select('kind', 'Publication type', c.PublicationKindSchema.options, 'circular', false)}${input('referenceNumber', 'Reference number (if known)')}${input('publicationDate', 'Publication date (leave blank if unknown)', 'date')}${input('effectiveDate', 'Effective date (leave blank if unknown)', 'date')}</div><p class="muted">Jurisdiction and regulator come from the selected source. Date fields remain unknown when left blank. The server verifies document bytes and metadata.</p><progress id="upload-progress" max="100" value="0" hidden></progress><p id="upload-state" role="status"></p><button class="primary" ${!live ? 'disabled' : ''}>Upload & process</button>${!live ? '<p class="warning-text">Upload is disabled in synthetic mode. Switch to Live API when Gokul’s ingestion endpoint is ready.</p>' : ''}</form></section>`);
  document.querySelector('#cancel-recovery')?.addEventListener('click', () => { recovery = undefined; void navigate(); });
  document.querySelector<HTMLFormElement>('#upload-form')!.onsubmit = event => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; void action(form.querySelector('button')!, async () => {
    const data = new FormData(form); const file = data.get('file'); if (!(file instanceof File) || !file.size) throw new Error('Select a nonempty PDF, DOCX or TXT file.');
    const source = sources.find(s => s.id === data.get('sourceId')); if (!source) throw new Error('Select a configured regulator.');
    const metadata = c.UploadMetadataSchema.parse({ title: String(data.get('title')).trim(), country: source.country, regulatorId: source.regulatorId, sourceId: source.id, kind: data.get('kind'), referenceNumber: String(data.get('referenceNumber')).trim() || null, publicationDate: data.get('publicationDate') || null, effectiveDate: data.get('effectiveDate') || null });
    const target = recovery; const progress = document.querySelector<HTMLProgressElement>('#upload-progress')!; const state = document.querySelector('#upload-state')!;
    const accepted = await upload(file, metadata, percent => { progress.hidden = false; progress.value = percent; state.textContent = `${percent}% transferred · awaiting backend acceptance`; });
    state.textContent = `Accepted · queued ingestion job ${accepted.jobId}`;
    const job = await track(accepted.jobId);
    if (job.state !== 'succeeded' || job.result?.kind !== 'ingestion') throw new Error(job.error?.message ?? 'Ingestion did not succeed. Predecessor has not been linked.');
    if (target) {
      const body = c.PredecessorLinkRequestSchema.parse({ referenceId: target.referenceId, currentVersionId: target.publication.currentVersionId, predecessorPublicationId: accepted.publicationId, predecessorVersionId: accepted.versionId });
      const linked = await request(c.API_CONTRACT.linkPredecessor, c.ComparisonAcceptedResponseSchema, { params: params(target.publication.id), body });
      recovery = undefined; await completeComparison(linked); location.hash = `publication/${target.publication.id}`;
    } else location.hash = `publication/${accepted.publicationId}`;
  }); };
}
async function navigate() {
  const hash = location.hash.slice(1); const token = ++generation;
  screen = hash.startsWith('publication/') ? 'detail' : hash === 'sources' ? 'sources' : hash === 'upload' ? 'upload' : 'repository'; shell();
  try { if (screen === 'sources') await sourceScreen(token); else if (screen === 'upload') await uploadScreen(token); else if (screen === 'detail') await detailScreen(c.IdSchema.parse(hash.slice(12)), token); else await repository(token); }
  catch (error) { if (token !== generation) return; content('<div class="panel empty"><h1>Unable to load this view</h1><p>Check backend availability or use synthetic fixtures to preview the interface.</p><button id="retry">Try again</button></div>'); document.querySelector('#retry')!.addEventListener('click', () => void navigate()); failure(error); }
}
window.addEventListener('hashchange', () => void navigate());
void navigate();
