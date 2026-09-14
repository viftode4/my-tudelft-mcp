import { load } from 'cheerio';
import type { BrightspaceClient } from './client.js';
import { BrightspaceError } from './errors.js';
import { array, numericId, plainText, record, safeSourceUrl, str, type Row } from './util.js';

export type RecordingTransport = Pick<BrightspaceClient, 'json' | 'sessionIdentity'> & { config: { baseUrl: string } };
export interface RecordingOptions { startAt?: number; maxDetails?: number; }
type ContentObject = { id: string; kind: 'module' | 'topic'; title: string; row: Row; ancestorModuleIds: string[] };
type Source = {
  courseId: string; topicId?: string; moduleId?: string; title: string; sourceUrl: string;
  metadataSources: string[]; fields: string[];
  readMaterial?: { tool: 'read_material'; arguments: { courseId: string; topicId: string } };
};
type Caption = {
  url: string; label: string; language?: string; source: Source; mediaUrl?: string;
  association?: 'media_track' | 'single_recording_in_source' | 'unverified';
};
type Recording = {
  url: string; title: string; provider: string; nativeMedia: boolean; sources: Source[];
  captionLinks: Caption[]; readMaterialTargets: { courseId: string; topicId: string }[];
};
const VIDEO = /\.(?:mp4|m4v|webm|mov|m3u8)$/i;
const MEDIA = /\.(?:mp4|m4v|webm|mov|m3u8|mp3|m4a|ogg|oga|wav)$/i;
const CAPTION = /\.(?:vtt|srt|ttml|dfxp)$/i;
const RECORDING = /\b(?:recordings?|recorded(?:\s+lectures?)?|lecture[\s_-]*(?:videos?|capture)|video[\s_-]*lectures?|weblectures?|collegerama|panopto|yuja|kaltura)\b/i;
const MAX_OBJECTS = 10_000, MAX_DESCRIPTION = 250_000, MAX_DESCRIPTION_TOTAL = 4_000_000, MAX_LINKS = 200, MAX_RECORDINGS = 1_000;
const MAX_CAPTIONS = 1_000, MAX_PROVENANCE = 2_000, MAX_OMISSION_DETAILS = 100;

function cleanTitle(input: unknown, origin: string): string {
  return plainText(str(input).slice(0, 2_000)).replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeSourceUrl(url, origin) ?? '[unsafe URL omitted]').slice(0, 500);
}
function classify(url: URL, title: string, directContext: string, origin: string): { provider: string; nativeMedia: boolean } | undefined {
  const host = url.hostname.toLowerCase(), path = url.pathname;
  if (url.origin === origin && MEDIA.test(path)) return { provider: 'Brightspace media', nativeMedia: true };
  if (host === 'collegeramavideoportal.tudelft.nl' && /^\/catalogue\/[^/]+\/presentation\/[a-z0-9-]+\/?$/i.test(path)
    || host === 'collegerama.tudelft.nl' && /^\/mediasite\/play\/[a-z0-9-]+\/?$/i.test(path)) return { provider: 'Collegerama', nativeMedia: false };
  if ((host === 'youtu.be' && /^\/[a-z0-9_-]+\/?$/i.test(path))
    || /^(?:www\.|m\.)?youtube\.com$/.test(host) && (path === '/watch' && Boolean(url.searchParams.get('v')) || /^\/(?:embed|shorts|live)\/[a-z0-9_-]+\/?$/i.test(path))) {
    return { provider: 'YouTube', nativeMedia: false };
  }
  if (/^(?:www\.|player\.)?vimeo\.com$/.test(host) && /^\/(?:video\/)?\d+\/?$/.test(path)) return { provider: 'Vimeo', nativeMedia: false };
  if (/(?:^|\.)panopto\.(?:com|eu)$/.test(host) && /\/(?:Pages\/Viewer|Pages\/Embed)\.aspx$/i.test(path)) return { provider: 'Panopto', nativeMedia: false };
  if (/(?:^|\.)yuja\.com$/.test(host) && /\/(?:V|Video|api\/v1\/video|Playlist)/i.test(path)) return { provider: 'YuJa', nativeMedia: false };
  if (/(?:^|\.)kaltura\.com$/.test(host) && /\/(?:p\/|media\/|entryid\/)/i.test(path)) return { provider: 'Kaltura', nativeMedia: false };
  if (/(?:^|\.)sharepoint\.com$/.test(host)
    && (/^\/:v:\//i.test(path) || MEDIA.test(path) || /\/stream\.aspx$/i.test(path)
      || RECORDING.test(title || directContext) && !/\.(?:pdf|docx?|xlsx?|pptx?)$/i.test(path))) {
    return { provider: 'SharePoint recording link', nativeMedia: false };
  }
  if (url.origin === origin && /\/(?:lti|extlinks?)\//i.test(path) && RECORDING.test(title || directContext)) {
    return { provider: 'Brightspace external-tool recording link', nativeMedia: false };
  }
  if (MEDIA.test(path)) return { provider: VIDEO.test(path) ? 'External video' : 'External audio', nativeMedia: false };
  return undefined;
}
function objects(payload: unknown, origin: string): ContentObject[] {
  const root = record(payload);
  if (!Array.isArray(root.Modules)) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar course-content tree.');
  const output: ContentObject[] = [], seen = new Set<string>();
  const add = (row: Row, kind: ContentObject['kind'], ancestorModuleIds: string[]): string => {
    const id = numericId(kind === 'module' ? row.ModuleId ?? row.Id : row.TopicId ?? row.Id), key = kind + ':' + id;
    if (seen.has(key) || output.length >= MAX_OBJECTS) throw new BrightspaceError('API_FORMAT_CHANGED', 'The course-content tree is duplicated or exceeds the inspection limit.');
    seen.add(key); output.push({ id, kind, title: cleanTitle(row.Title, origin), row, ancestorModuleIds });
    return id;
  };
  const walk = (nodes: unknown[], depth = 0, ancestorModuleIds: string[] = []): void => {
    if (depth > 30) throw new BrightspaceError('CONTENT_DEPTH', 'The course-content tree is unexpectedly deep.');
    for (const value of nodes) {
      const row = record(value);
      if (row.IsHidden === true || row.IsLocked === true) continue;
      if (row.Modules != null && !Array.isArray(row.Modules) || row.Topics != null && !Array.isArray(row.Topics)) {
        throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned an unfamiliar course module.');
      }
      const moduleId = add(row, 'module', ancestorModuleIds), descendants = [...ancestorModuleIds, moduleId];
      for (const raw of array(row.Topics)) { const topic = record(raw); if (topic.IsHidden !== true && topic.IsLocked !== true) add(topic, 'topic', descendants); }
      walk(array(row.Modules), depth + 1, descendants);
    }
  };
  walk(root.Modules);
  return output;
}

/** Discover links from visible Brightspace metadata. Never visits a provider or downloads media. */
export class CourseRecordings {
  constructor(private readonly client: RecordingTransport) {}

  async list(courseId: string, options: RecordingOptions = {}): Promise<Row> {
    const id = numericId(courseId), startAt = options.startAt ?? 0, maxDetails = options.maxDetails ?? 20, origin = this.client.config.baseUrl;
    if (!Number.isSafeInteger(startAt) || startAt < 0 || !Number.isSafeInteger(maxDetails) || maxDetails < 0 || maxDetails > 50) {
      throw new BrightspaceError('INVALID_RANGE', 'Use a nonnegative startAt and maxDetails between 0 and 50.');
    }
    const account = await this.client.sessionIdentity();
    if (!account) throw new BrightspaceError('AUTH_REQUIRED', 'Verify the Brightspace account before discovering recordings.');
    const tree = objects(await this.client.json('le', id + '/content/toc'), origin);
    const rank = (item: ContentObject): number => {
      if (RECORDING.test(item.title) || /collegerama|panopto|yuja|kaltura|\.(?:mp4|webm|m3u8)/i.test(str(item.row.Url))) return 0;
      if (item.kind === 'topic' && (Number(item.row.ActivityType) === 2 || Number(item.row.TopicType) === 3)) return 1;
      return item.kind === 'module' ? 2 : 3;
    };
    const queue = [...tree].sort((a, b) => rank(a) - rank(b) || a.kind.localeCompare(b.kind) || a.id.length - b.id.length || a.id.localeCompare(b.id));
    if (startAt > queue.length) throw new BrightspaceError('INVALID_RANGE', 'startAt is beyond this course content. Restart at 0 if the course changed.');
    const grouped = new Map<string, Recording>(), captions = new Map<string, Caption>(), omissions: Row[] = [], errors: Row[] = [], excluded = new Set<string>();
    const omissionKeys = new Set<string>(), omissionsByReason: Record<string, number> = {};
    const incompleteSources = new Set<string>(), ambiguousRecordingSources = new Set<string>(), firstRecordingBySource = new Map<string, string>();
    let descriptionCharacters = 0, provenanceCount = 0;
    const key = (object: ContentObject) => object.kind + ':' + object.id;
    const omit = (object: ContentObject, reason: string): void => {
      const omissionKey = key(object) + ':' + reason;
      incompleteSources.add(key(object));
      if (omissionKeys.has(omissionKey)) return;
      omissionKeys.add(omissionKey); omissionsByReason[reason] = (omissionsByReason[reason] ?? 0) + 1;
      if (omissions.length < MAX_OMISSION_DETAILS) omissions.push({ objectType: object.kind, objectId: object.id, reason });
    };
    const source = (object: ContentObject, stage: string, field: string): Source => ({
      courseId: id, ...(object.kind === 'topic' ? { topicId: object.id } : { moduleId: object.id }), title: object.title,
      sourceUrl: origin + '/d2l/le/content/' + id + (object.kind === 'topic' ? '/viewContent/' + object.id + '/View' : '/Home'),
      metadataSources: [stage], fields: [field],
    });
    const sourceKey = (item: Source): string => item.topicId ? 'topic:' + item.topicId : 'module:' + item.moduleId;
    const inspect = (object: ContentObject, stage: string): void => {
      let linkCount = 0, linkLimitReported = false;
      const link = (raw: string, label: string, field: string, language?: string, mediaUrl?: string): void => {
        if (++linkCount > MAX_LINKS) { if (!linkLimitReported) omit(object, 'link_limit'); linkLimitReported = true; return; }
        const safe = safeSourceUrl(raw, origin); if (!safe) return;
        const url = new URL(safe), src = source(object, stage, field);
        if (CAPTION.test(url.pathname)) {
          const associatedMedia = mediaUrl ? safeSourceUrl(mediaUrl, origin) : undefined;
          const captionKey = safe + '|' + key(object) + '|' + (associatedMedia ?? ''), existing = captions.get(captionKey);
          if (existing) {
            existing.source.metadataSources = [...new Set([...existing.source.metadataSources, stage])];
            existing.source.fields = [...new Set([...existing.source.fields, field])];
            return;
          }
          if (captions.size >= MAX_CAPTIONS) { omit(object, 'caption_limit'); return; }
          if (provenanceCount >= MAX_PROVENANCE) { omit(object, 'provenance_limit'); return; }
          captions.set(captionKey, { url: safe, label: cleanTitle(label, origin), ...(language ? { language: cleanTitle(language, origin) } : {}), source: src, ...(associatedMedia ? { mediaUrl: associatedMedia } : {}) });
          provenanceCount++; return;
        }
        const classification = classify(url, label, field === 'url' ? object.title : '', origin);
        if (!classification) return;
        const sourceId = key(object), firstRecording = firstRecordingBySource.get(sourceId);
        if (firstRecording && firstRecording !== safe) ambiguousRecordingSources.add(sourceId);
        else if (!firstRecording) firstRecordingBySource.set(sourceId, safe);
        let item = grouped.get(safe);
        if (!item) {
          if (grouped.size >= MAX_RECORDINGS) { omit(object, 'recording_limit'); return; }
          if (provenanceCount >= MAX_PROVENANCE) { omit(object, 'provenance_limit'); return; }
          item = { url: safe, title: cleanTitle(label || object.title, origin), ...classification, sources: [], captionLinks: [], readMaterialTargets: [] };
          grouped.set(safe, item);
        }
        if (classification.nativeMedia && object.kind === 'topic' && field === 'url') src.readMaterial = { tool: 'read_material', arguments: { courseId: id, topicId: object.id } };
        const existing = item.sources.find((candidate) => sourceKey(candidate) === key(object));
        if (existing) {
          existing.metadataSources = [...new Set([...existing.metadataSources, stage])]; existing.fields = [...new Set([...existing.fields, field])];
          if (src.readMaterial) existing.readMaterial = src.readMaterial;
        } else {
          if (provenanceCount >= MAX_PROVENANCE) { omit(object, 'provenance_limit'); return; }
          item.sources.push(src); provenanceCount++;
        }
      };
      const directUrl = str(object.row.Url);
      if (directUrl) link(directUrl, object.title, 'url');
      const raw = object.row.Description, rich = record(raw), html = typeof raw === 'string' ? raw : str(rich.Html || rich.Content || rich.Text);
      if (!html) return;
      if (html.length > MAX_DESCRIPTION || descriptionCharacters + html.length > MAX_DESCRIPTION_TOTAL || (html.match(/</g)?.length ?? 0) > 10_000) {
        omit(object, 'description_limit'); return;
      }
      descriptionCharacters += html.length;
      const $ = load(html);
      $('a[href],iframe[src],video[src],audio[src],source[src],track[src]').each((_, element) => {
        const node = $(element), rawUrl = node.attr('href') || node.attr('src') || '';
        const parent = node.closest('video,audio'), associatedMedia = element.tagName === 'track' ? parent.attr('src') || parent.find('source[src]').first().attr('src') : undefined;
        link(rawUrl, cleanTitle(node.text() || node.attr('title') || node.attr('label'), origin), 'description_' + element.tagName, node.attr('srclang'), associatedMedia);
      });
      $('script,style,noscript,template').remove();
      // Parse visible plain-text URLs separately, avoiding raw HTML entity variants.
      for (const match of $.root().text().matchAll(/https?:\/\/[^\s<>"']+/gi)) link(match[0], '', 'description_text_url');
    };
    for (const item of tree) inspect(item, 'toc');
    const selected = queue.slice(startAt, startAt + maxDetails);
    let attemptedDetails = 0, successfulDetails = 0, hiddenDetails = 0;
    for (let index = 0; index < selected.length; index++) {
      const item = selected[index]!;
      if (excluded.has(key(item))) continue;
      attemptedDetails++;
      try {
        const detail = record(await this.client.json('le', id + '/content/' + (item.kind === 'topic' ? 'topics/' : 'modules/') + item.id));
        const returnedId = str(detail.Id ?? detail.TopicId ?? detail.ModuleId);
        if (returnedId !== item.id) throw new BrightspaceError('API_FORMAT_CHANGED', 'Brightspace returned a different content object.');
        successfulDetails++;
        if (detail.IsHidden === true || detail.IsLocked === true) {
          hiddenDetails++;
          excluded.add(key(item));
          if (item.kind === 'module') {
            for (const descendant of tree) if (descendant.ancestorModuleIds.includes(item.id)) excluded.add(key(descendant));
          }
          continue;
        }
        inspect({ ...item, title: cleanTitle(detail.Title, origin) || item.title, row: detail }, item.kind + '_detail');
      } catch (error) {
        if (error instanceof BrightspaceError && ['AUTH_REQUIRED', 'ACCOUNT_CHANGED', 'VAULT_ERROR'].includes(error.code)) throw error;
        errors.push({ startAt: startAt + index, objectType: item.kind, objectId: item.id, code: error instanceof BrightspaceError ? error.code : 'INTERNAL_ERROR' });
      }
    }
    if (await this.client.sessionIdentity() !== account) throw new BrightspaceError('ACCOUNT_CHANGED', 'The Brightspace account changed while discovering recordings.');
    const captionMap = new Map<string, Caption>();
    for (const caption of captions.values()) if (!excluded.has(sourceKey(caption.source))) {
      const captionKey = caption.url + '|' + sourceKey(caption.source) + '|' + (caption.mediaUrl ?? '');
      if (!captionMap.has(captionKey)) captionMap.set(captionKey, caption);
    }
    const items = [...grouped.values()].filter((item) => {
      item.sources = item.sources.filter((src) => !excluded.has(sourceKey(src)));
      item.readMaterialTargets = item.sources.flatMap((src) => src.readMaterial ? [src.readMaterial.arguments] : []);
      return item.sources.length > 0;
    });
    const urlsBySource = new Map<string, Set<string>>();
    for (const item of items) for (const src of item.sources) {
      const sourceId = sourceKey(src), urls = urlsBySource.get(sourceId) ?? new Set<string>();
      urls.add(item.url); urlsBySource.set(sourceId, urls);
    }
    const visibleCaptions = [...captionMap.values()].map((caption): Caption => ({
      ...caption, association: caption.mediaUrl ? 'media_track'
        : !incompleteSources.has(sourceKey(caption.source)) && !ambiguousRecordingSources.has(sourceKey(caption.source))
          && urlsBySource.get(sourceKey(caption.source))?.size === 1 ? 'single_recording_in_source' : 'unverified',
    }));
    for (const item of items) {
      item.captionLinks = visibleCaptions.filter((caption) => caption.mediaUrl ? caption.mediaUrl === item.url
        : caption.association === 'single_recording_in_source' && urlsBySource.get(sourceKey(caption.source))?.has(item.url));
    }
    const nextStartAt = startAt + selected.length < queue.length ? startAt + selected.length : null;
    return {
      source: 'api_metadata', courseId: id, fetchedAt: new Date().toISOString(), items, captionLinks: visibleCaptions,
      complete: startAt === 0 && nextStartAt === null && errors.length === 0 && omissions.length === 0,
      nextStartAt, coverage: {
        tocComplete: true, visibleModules: tree.filter((item) => item.kind === 'module').length, visibleTopics: tree.filter((item) => item.kind === 'topic').length,
        detailObjects: queue.length, startAt, requestedDetails: maxDetails, consumedDetailObjects: selected.length,
        attemptedDetails, successfulDetails, skippedDetails: selected.length - attemptedDetails,
        remainingDetails: queue.length - startAt - selected.length, excludedDetails: hiddenDetails, excludedObjects: excluded.size, errors, omissions,
        omissionCount: omissionKeys.size, omissionsByReason, omissionDetailsTruncated: omissionKeys.size > omissions.length,
        limits: { recordings: MAX_RECORDINGS, captionLinks: MAX_CAPTIONS, provenanceSources: MAX_PROVENANCE, omissionDetails: MAX_OMISSION_DETAILS },
        currentCallOnly: true, scope: 'Visible TOC links plus this page of module/topic metadata. Course files, provider pages, playback and caption contents were not read.',
      },
      warning: 'Recording and caption links are metadata references. Playback, lecture content and transcript availability are unverified. Merge sources by URL across pages; course changes can shift startAt.',
    };
  }
}
