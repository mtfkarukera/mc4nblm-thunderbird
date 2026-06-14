// rpc_client.js — Client RPC NotebookLM (Thunderbird MV2)
// NotebookLM Clipper for Thunderbird
//
// ⚠️ Les fonctions parseChunkedResponse et extractRpcResult sont la
// traduction exacte de decoder.py — NE JAMAIS les réécrire.
//
// Référence : API-REFERENCE.md §2, §3, §4, §5, §6

'use strict';

const NBLM_BATCH_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute';

// Stockage du dernier texte HTTP brut (diagnostic)
let _lastRawText = '(non récupéré)';
let _lastBytesLength = -1;
let _lastChunksLength = -1;
let _lastError = '';

// ─── Parser de réponse chunkée Google ─────────────────────────────────────────
// ⚠️ Le sizeHeader Google correspond au nombre de caractères de la chaîne JS
// (UTF-16 code units), pas au nombre d'octets.
// Slicing string direct par String.substring() requis pour éviter les décalages.
// ──────────────────────────────────────────────────────────────────────────────

function parseChunkedResponse(responseBytes) {
  if (!responseBytes) return [];

  let text;
  if (responseBytes instanceof Uint8Array) {
    text = new TextDecoder('utf-8').decode(responseBytes);
  } else if (typeof responseBytes === 'string') {
    text = responseBytes;
  } else {
    return [];
  }

  if (!text.trim()) return [];

  // Supprimer le préfixe anti-XSSI ")]}'\n" (ou n'importe quel nombre de \n\r)
  const cleaned = text.replace(/^\)\]\}'[\r\n]+/, '');
  const chunks = [];
  const lines = cleaned.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Skip lignes vides
    if (!line) {
      i++;
      continue;
    }

    // Si la ligne courante est un entier (taille du chunk)
    if (/^\d+$/.test(line)) {
      i++; // Avancer à la ligne suivante (le payload JSON)
      if (i < lines.length) {
        const jsonStr = lines[i];
        try {
          chunks.push(JSON.parse(jsonStr));
        } catch (e) {
          // Fallback de secours si le JSON contient des caractères en trop ou est tronqué
          const lastBracket = Math.max(jsonStr.lastIndexOf(']'), jsonStr.lastIndexOf('}'));
          if (lastBracket !== -1) {
            const trimmedJsonStr = jsonStr.substring(0, lastBracket + 1);
            try {
              chunks.push(JSON.parse(trimmedJsonStr));
            } catch (err2) {
              const errDetail = `[c${chunks.length + 1} err: ${e.message} (fallback: ${err2.message}) | len: ${jsonStr.length} | start: ${jsonStr.slice(0, 30)} | end: ${jsonStr.slice(-30)}]`;
              _lastError = _lastError ? _lastError + ' || ' + errDetail : errDetail;
            }
          } else {
            const errDetail = `[c${chunks.length + 1} err: ${e.message} | len: ${jsonStr.length} | start: ${jsonStr.slice(0, 30)} | end: ${jsonStr.slice(-30)}]`;
            _lastError = _lastError ? _lastError + ' || ' + errDetail : errDetail;
          }
          // Fragment de réponse brute : DEBUG uniquement (audit 2026-06-10)
          NtcUtils.log('parseChunkedResponse — JSON.parse échoué sur chunk:', jsonStr.slice(0, 80));
        }
      }
    }
    i++;
  }

  return chunks;
}


const _GRPC_STATUS_MESSAGES = {
  0: "OK",
  1: "Cancelled",
  2: "Unknown",
  3: "Invalid argument",
  4: "Deadline exceeded",
  5: "Not found",
  6: "Already exists",
  7: "Permission denied",
  8: "Resource exhausted",
  9: "Failed precondition",
  10: "Aborted",
  11: "Out of range",
  12: "Not implemented",
  13: "Internal",
  14: "Unavailable",
  15: "Data loss",
  16: "Unauthenticated"
};

function extractRpcResult(chunks, rpcId) {
  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;
    // Les chunks Google peuvent être une liste de listes ou une liste plate d'items
    const items = (chunk.length > 0 && Array.isArray(chunk[0])) ? chunk : [chunk];
    
    for (const item of items) {
      if (!Array.isArray(item) || item.length < 3) continue;
      const [type, id, data] = item;
      if (id !== rpcId) continue;
      
      if (type === 'er') {
        throw new Error(`RPC error for ${rpcId}: ${JSON.stringify(data)}`);
      }
      if (type === 'wrb.fr') {
        // Détecter les erreurs gRPC à l'index 5 de wrb.fr
        const errorInfo = item[5];
        if (data === null && errorInfo !== undefined && errorInfo !== null) {
          if (Array.isArray(errorInfo) && errorInfo.length > 0) {
            const code = errorInfo[0];
            if (typeof code === 'number' && _GRPC_STATUS_MESSAGES[code]) {
              const errMsg = `RPC error ${rpcId} returned null result with status code ${code} (${_GRPC_STATUS_MESSAGES[code]}).`;
              const err = new Error(errMsg);
              err.grpcCode = code;
              throw err;
            }
          }
        }
        try {
          return typeof data === 'string' ? JSON.parse(data) : data;
        } catch (_e) {
          return data;
        }
      }
    }
  }
  return null;
}

const _SOURCE_ID_UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const _SOURCE_ID_FIELD_NAMES = new Set(["SOURCE_ID", "source_id", "sourceId"]);
const _CONTEXTUAL_SOURCE_ID_FIELD_NAMES = new Set(["id"]);
const _SOURCE_NAME_FIELD_NAMES = new Set(["SOURCE_NAME", "source_name", "sourceName", "filename", "fileName", "name", "title"]);
const _SOURCE_ID_ENVELOPE_MAX_DEPTH = 8;

function _unwrap_singleton_envelope(value) {
  let depth = 0;
  while (Array.isArray(value) && value.length === 1 && depth < _SOURCE_ID_ENVELOPE_MAX_DEPTH) {
    value = value[0];
    depth++;
  }
  return { value, depth };
}

function _coerce_filename_candidate(value) {
  const unwrapped = _unwrap_singleton_envelope(value);
  if (typeof unwrapped.value !== 'string') return null;
  return unwrapped.value.trim();
}

function _looks_like_id_string(candidate) {
  if (candidate.length < 4) return false;
  if (candidate.includes(' ') || candidate.includes('\t') || candidate.includes('/')) return false;
  return /[0-9]/.test(candidate) || candidate.includes('-') || candidate.includes('_');
}

function _coerce_source_id_candidate(value, filename) {
  const unwrapped = _unwrap_singleton_envelope(value);
  if (typeof unwrapped.value !== 'string') return null;
  if (unwrapped.value.length > 1000) return null;
  const candidate = unwrapped.value.trim();
  if (!candidate || candidate === filename) return null;
  if (_SOURCE_ID_UUID_PATTERN.test(candidate) || _looks_like_id_string(candidate)) {
    return candidate;
  }
  return null;
}

function _source_context_names(node) {
  const names = [];
  for (const [key, val] of Object.entries(node)) {
    if (_SOURCE_NAME_FIELD_NAMES.has(key)) {
      names.push(val);
    }
  }
  return names;
}

function _extract_source_id_field_candidates(result, filename) {
  const candidates = [];
  const seen = new Set();

  function add_candidate(val) {
    const candidate = _coerce_source_id_candidate(val, filename);
    if (candidate !== null && !seen.has(candidate)) {
      candidates.push(candidate);
      seen.add(candidate);
    }
  }

  function walk(node, depth) {
    if (depth > _SOURCE_ID_ENVELOPE_MAX_DEPTH) return;
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      const names = _source_context_names(node);
      const matched_context = names.length > 0 && names.some(name => _coerce_filename_candidate(name) === filename);
      const mismatched_context = names.length > 0 && !matched_context;
      
      for (const [key, val] of Object.entries(node)) {
        if (
          (_SOURCE_ID_FIELD_NAMES.has(key) && !mismatched_context && (depth === 0 || matched_context)) ||
          (_CONTEXTUAL_SOURCE_ID_FIELD_NAMES.has(key) && matched_context)
        ) {
          add_candidate(val);
        }
      }
      for (const val of Object.values(node)) {
        walk(val, depth + 1);
      }
    } else if (Array.isArray(node)) {
      for (const child of node) {
        walk(child, depth + 1);
      }
    }
  }

  walk(result, 0);
  return candidates;
}

function _extract_contextual_source_id_row_candidates(result, filename) {
  const candidates = [];
  const seen = new Set();

  function add_candidate(val) {
    const candidate = _coerce_source_id_candidate(val, filename);
    if (candidate !== null && !seen.has(candidate)) {
      candidates.push(candidate);
      seen.add(candidate);
    }
  }

  function walk(node, depth) {
    if (depth > _SOURCE_ID_ENVELOPE_MAX_DEPTH) return;
    if (Array.isArray(node)) {
      if (node.length >= 2) {
        if (_coerce_filename_candidate(node[1]) === filename) {
          add_candidate(node[0]);
        }
        if (_coerce_filename_candidate(node[0]) === filename) {
          add_candidate(node[1]);
        }
      }
      for (const child of node) {
        walk(child, depth + 1);
      }
    } else if (node && typeof node === 'object') {
      for (const val of Object.values(node)) {
        walk(val, depth + 1);
      }
    }
  }

  walk(result, 0);
  return candidates;
}

function _extract_singleton_source_id_envelope(result, filename) {
  const unwrapped = _unwrap_singleton_envelope(result);
  if (unwrapped.depth === 0) return null;
  return _coerce_source_id_candidate(unwrapped.value, filename);
}

function _extract_prefixed_singleton_source_id_envelope(result, filename) {
  if (!Array.isArray(result) || result.length !== 2 || result[0] !== null) {
    return null;
  }
  return _extract_singleton_source_id_envelope(result[1], filename);
}

function extractRegisterFileSourceId(result, filename) {
  const field_candidates = _extract_source_id_field_candidates(result, filename);
  if (field_candidates.length === 1) return field_candidates[0];
  if (field_candidates.length > 1) return null;

  const row_candidates = _extract_contextual_source_id_row_candidates(result, filename);
  if (row_candidates.length === 1) return row_candidates[0];
  if (row_candidates.length > 1) return null;

  const prefixed_candidate = _extract_prefixed_singleton_source_id_envelope(result, filename);
  if (prefixed_candidate !== null) return prefixed_candidate;

  return _extract_singleton_source_id_envelope(result, filename);
}

// ─────────────────────────────────────────────
// ENCODEUR RPC — traduction de encoder.py
// ─────────────────────────────────────────────

function encodeRpcRequest(rpcId, params) {
  const paramsJson = JSON.stringify(params);
  const inner = [rpcId, paramsJson, null, 'generic'];
  return [[inner]];
}

function buildRequestBody(rpcRequest, csrfToken) {
  const fReq = JSON.stringify(rpcRequest);
  let body = `f.req=${encodeURIComponent(fReq)}`;
  if (csrfToken) body += `&at=${encodeURIComponent(csrfToken)}`;
  return `${body}&`;
}

function buildQueryString(rpcId, authuserIndex) {
  return new URLSearchParams({
    rpcids: rpcId,
    'source-path': '/',
    hl: 'en',
    rt: 'c',
    authuser: String(authuserIndex),
  }).toString();
}

// ─────────────────────────────────────────────
// UTILITAIRES
// ─────────────────────────────────────────────

const _UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recherche récursive du premier string au format UUID dans une structure
 * imbriquée (secours pour l'extraction d'ID de carnet — hotfix 2026-06-11).
 */
function extractFirstUuid(data) {
  if (typeof data === 'string') return _UUID_PATTERN.test(data) ? data : null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = extractFirstUuid(item);
      if (found) return found;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// REQUÊTE GÉNÉRIQUE batchexecute
// ─────────────────────────────────────────────

async function batchExecute(rpcId, params, csrfToken, authuserIndex) {
  _lastError = '';
  _lastBytesLength = -1;
  _lastChunksLength = -1;
  _lastRawText = '(non récupéré)';

  const rpcReq = encodeRpcRequest(rpcId, params);
  NtcUtils.log('batchExecute', rpcId, '— params length:', JSON.stringify(params).length);
  const body = buildRequestBody(rpcReq, csrfToken);
  const qs = buildQueryString(rpcId, authuserIndex);
  const url = `${NBLM_BATCH_URL}?${qs}`;

  // AbortController — timeout 30s pour les appels RPC
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Origin': 'https://notebooklm.google.com',
        'Referer': 'https://notebooklm.google.com/',
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr.name === 'AbortError') {
      const e = new Error('TIMEOUT'); e.code = 'TIMEOUT'; throw e;
    }
    throw fetchErr;
  }

  NtcUtils.log('batchExecute', rpcId, '→ HTTP', resp.status, 'ok?', resp.ok);

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      const e = new Error('AUTH_EXPIRED'); e.code = 'AUTH_EXPIRED'; throw e;
    }
    throw new Error(`HTTP ${resp.status}`);
  }

  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  _lastBytesLength = bytes.length;

  // Mettre à jour _lastRawText pour le diagnostic (en décodant en UTF-8)
  try {
    _lastRawText = new TextDecoder('utf-8').decode(bytes);
  } catch (err) {
    _lastRawText = '(échec décodage UTF-8)';
    _lastError = 'dec_err: ' + err.message;
  }

  try {
    const chunks = parseChunkedResponse(bytes);
    _lastChunksLength = chunks.length;
    const result = extractRpcResult(chunks, rpcId);
    NtcUtils.log('batchExecute', rpcId, '— chunks:', chunks.length, 'result:', result === null ? 'null' : typeof result);
    _lastRawText = ''; // P1.8 — Purge après extraction pour libérer la mémoire
    return result;
  } catch (err) {
    _lastError = 'parse_err: ' + err.message;
    throw err;
  }
}

// ─────────────────────────────────────────────
// API PUBLIQUE — Carnets
// ─────────────────────────────────────────────

/**
 * Liste les carnets NotebookLM.
 * RPC ID : wXbhsf (voir API-REFERENCE.md §1)
 *
 * Les entrées diagnostic `__diag__` ne sont générées qu'en mode
 * NtcUtils.DEBUG (revue 2026-06-10). En production : liste vide si le
 * résultat est null/vide (compte sans carnet — cas légitime), erreur
 * API_CHANGED si la structure est inattendue.
 *
 * @param {string} csrfToken
 * @param {number} authuserIndex
 * @returns {Promise<{ notebooks: Array<{ id: string, title: string }> }>}
 */
async function listNotebooks(csrfToken, authuserIndex) {
  NtcUtils.log('listNotebooks — csrfToken présent?', !!csrfToken, 'authuser:', authuserIndex);
  const result = await batchExecute('wXbhsf', [null, 1, null, [2]], csrfToken, authuserIndex);

  // ── Résultat null ou vide : compte sans carnet (cas légitime) ───────────
  if (!result || (Array.isArray(result) && result.length === 0)) {
    if (NtcUtils.DEBUG) {
      const raw = _lastRawText.slice(0, 80).replace(/\r?\n/g, '↵');
      const diagTitle = `🔍 B:${_lastBytesLength} C:${_lastChunksLength} Err:${_lastError} Raw:${raw}`;
      return { notebooks: [{ id: '__diag__', title: diagTitle }] };
    }
    return { notebooks: [] };
  }
  // ── Structure inattendue : API probablement modifiée ────────────────────
  if (!Array.isArray(result)) {
    if (NtcUtils.DEBUG) {
      const raw = JSON.stringify(result).slice(0, 120);
      return { notebooks: [{ id: '__diag__', title: '🔍 non-array: ' + raw }] };
    }
    const e = new Error('API_CHANGED'); e.code = 'API_CHANGED'; throw e;
  }

  // ── Mapping ─────────────────────────────────────────────────────────────
  // Structure observée dans la réponse brute :
  //   result = [                          ← extractRpcResult retourne ça
  //     [                                 ← result[0] = liste des carnets
  //       ["Titre carnet", [[[id,...]]],  ← result[0][i] = carnet i
  //       ...
  //     ],
  //     ...
  //   ]
  // Accès : title = nb[0], id = nb[1][0][0][0]

  /**
   * Extrait l'ID d'un carnet depuis la structure imbriquée.
   * Essaie plusieurs chemins de secours si la structure varie.
   */
  function extractId(nb) {
    // Chemin principal (Notebook UUID) : nb[2]
    if (nb && nb.length > 2 && typeof nb[2] === 'string' && nb[2].match(/^[0-9a-f-]{36}$/i)) {
      return nb[2];
    }
    // Chemin de secours (ex: si l'ID est décalé à l'index 3)
    if (nb && nb.length > 3 && typeof nb[3] === 'string' && nb[3].match(/^[0-9a-f-]{36}$/i)) {
      return nb[3];
    }
    // Chemins de secours historiques
    try { if (typeof nb[1][0][0][0] === 'string') return nb[1][0][0][0]; } catch (_e) { /* */ }
    try { if (typeof nb[1][0][0] === 'string') return nb[1][0][0]; } catch (_e) { /* */ }
    // Secours : nb[0] si string et ressemble à un UUID
    if (typeof nb[0] === 'string' && nb[0].includes('-')) return nb[0];
    return null;
  }

  /**
   * Extrait le titre d'un carnet.
   */
  function extractTitle(nb) {
    // Chemin principal : nb[0] si string et pas un UUID
    if (typeof nb[0] === 'string' && !nb[0].match(/^[0-9a-f-]{36}$/i)) return nb[0];
    // Secours : nb[1] si string
    if (typeof nb[1] === 'string') return nb[1];
    return '(sans titre)';
  }

  // La liste des carnets est dans result[0]
  const nbList = Array.isArray(result[0]) ? result[0] : result;

  const notebooks = nbList
    .filter(nb => Array.isArray(nb) && nb.length >= 2)
    .map(nb => {
      const id = extractId(nb);
      const title = extractTitle(nb);
      return { id, title };
    })
    .filter(nb => nb.id !== null);

  NtcUtils.log('carnets trouvés :', notebooks.length);

  if (notebooks.length === 0 && !NtcUtils.DEBUG) {
    // Des données présentes mais aucun carnet mappé → structure modifiée
    const e = new Error('API_CHANGED'); e.code = 'API_CHANGED'; throw e;
  }
  if (notebooks.length === 0) {
    // Mode DEBUG : montrer la structure brute du premier élément
    const raw0 = JSON.stringify(nbList[0]).slice(0, 150);
    return {
      notebooks: [
        { id: '__diag__', title: '🔍 nbList[0]: ' + raw0 },
      ]
    };
  }

  return { notebooks };
}

/**
 * Crée un nouveau carnet NotebookLM.
 * RPC ID : CCqFvf (voir API-REFERENCE.md §1)
 *
 * @param {string} csrfToken
 * @param {string} title
 * @param {number} authuserIndex
 * @returns {Promise<{ id: string, title: string }>}
 */
async function createNotebook(csrfToken, title, authuserIndex) {
  // Payload canonique CCqFvf (hotfix 2026-06-11, recettage R8.2) :
  //   [title, null, null, [2], [1]]
  // Source de vérité : notebooklm-py build_create_notebook_params().
  // L'ancien payload [[title]] provoquait un gRPC 3 (Invalid argument).
  // ⚠️ Avec ce payload canonique, un gRPC 3 signifie désormais
  //    « quota de carnets atteint » (CREATE_NOTEBOOK_QUOTA_RPC_CODE).
  const params = [title, null, null, [2], [1]];
  const result = await batchExecute('CCqFvf', params, csrfToken, authuserIndex);

  // Réponse = ligne carnet : titre en [0], ID (UUID) en [2]
  // (notebooklm-py Notebook.from_api_response). L'ancien extractFirstString
  // retournait le TITRE — bug latent corrigé (hotfix 2026-06-11).
  let id = null;
  if (Array.isArray(result) && typeof result[2] === 'string' && _UUID_PATTERN.test(result[2])) {
    id = result[2];
  } else {
    id = extractFirstUuid(result);  // secours si la structure se décale
  }

  if (!id) { const e = new Error('API_CHANGED'); e.code = 'API_CHANGED'; throw e; }
  return { id, title };
}

// ─────────────────────────────────────────────
// API PUBLIQUE — Import Sources (Phase 3+)
// ─────────────────────────────────────────────

/**
 * Importe une source texte (MD email) dans un carnet.
 * RPC ID : izAoDd — wrapper 8-slots, slot [1] (API-REFERENCE.md §5.1)
 *
 * @param {string} csrfToken
 * @param {string} text
 * @param {string} title
 * @param {string} notebookId
 * @param {number} authuserIndex
 */
async function addTextSource(csrfToken, text, title, notebookId, authuserIndex) {
  const params = [
    [[null, [title, text], null, null, null, null, null, null]],
    notebookId, [2], null, null
  ];
  return await batchExecute('izAoDd', params, csrfToken, authuserIndex);
}

// addUrlSource() supprimé — revue de code 2026-06-10 (pipeline URL retiré de la v1).
// Réintroduction éventuelle : voir API-REFERENCE.md §5.2 (wrapper 8-slots, slot [2]).

/**
 * Upload resumable d'un fichier binaire (PDF, PJ) dans un carnet.
 * Protocole 3 étapes : register → start → upload+finalize (API-REFERENCE.md §6)
 *
 * @param {string} csrfToken
 * @param {Blob}   fileBlob
 * @param {string} filename
 * @param {string} notebookId
 * @param {number} authuserIndex
 */
async function uploadFileSource(csrfToken, fileBlob, filename, notebookId, authuserIndex, contentType) {
  // Étape 1 — Register (RPC o4cbdc)
  const registerParams = [
    [[filename]],
    notebookId, [2],
    [1, null, null, null, null, null, null, null, null, null, [1]]
  ];
  const registerResult = await batchExecute('o4cbdc', registerParams, csrfToken, authuserIndex);
  const sourceId = extractRegisterFileSourceId(registerResult, filename);

  if (!sourceId) {
    const e = new Error('API_CHANGED'); e.code = 'API_CHANGED'; throw e;
  }

  // Étape 2 — Start upload (timeout 120s pour les fichiers volumineux)
  const startController = new AbortController();
  const startTimeoutId = setTimeout(() => startController.abort(), 120000);

  let startResp;
  try {
    startResp = await fetch(
      `https://notebooklm.google.com/upload/_/?authuser=${authuserIndex}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept': '*/*',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Origin': 'https://notebooklm.google.com',
          'Referer': 'https://notebooklm.google.com/',
          'x-goog-upload-command': 'start',
          'x-goog-upload-protocol': 'resumable',
          'x-goog-upload-header-content-length': String(fileBlob.size),
          'x-goog-upload-header-content-type': contentType || fileBlob.type || 'application/octet-stream',
          'x-goog-authuser': String(authuserIndex),
        },
        body: JSON.stringify({
          PROJECT_ID: notebookId,
          SOURCE_NAME: filename,
          SOURCE_ID: sourceId,
        }),
        signal: startController.signal,
      }
    );
    clearTimeout(startTimeoutId);
  } catch (startErr) {
    clearTimeout(startTimeoutId);
    if (startErr.name === 'AbortError') {
      const e = new Error('TIMEOUT'); e.code = 'TIMEOUT'; throw e;
    }
    throw startErr;
  }

  // P1.5 — Vérification auth sur l'étape start
  if (startResp.status === 401 || startResp.status === 403) {
    const e = new Error('AUTH_EXPIRED'); e.code = 'AUTH_EXPIRED'; throw e;
  }

  // P1.4 — Validation du domaine uploadUrl
  const uploadUrl = startResp.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    const e = new Error('UPLOAD_SESSION_MISSING'); e.code = 'UPLOAD_SESSION_MISSING'; throw e;
  }
  try {
    const parsedUrl = new URL(uploadUrl);
    if (parsedUrl.protocol !== 'https:' ||
        !(parsedUrl.hostname.endsWith('.google.com') || parsedUrl.hostname.endsWith('.googleapis.com'))) {
      const e = new Error('UPLOAD_SESSION_MISSING'); e.code = 'UPLOAD_SESSION_MISSING'; throw e;
    }
  } catch (urlErr) {
    if (urlErr.code === 'UPLOAD_SESSION_MISSING') throw urlErr;
    const e = new Error('UPLOAD_SESSION_MISSING'); e.code = 'UPLOAD_SESSION_MISSING'; throw e;
  }

  // Étape 3 — Upload + finalize (timeout 120s)
  const finalizeController = new AbortController();
  const finalizeTimeoutId = setTimeout(() => finalizeController.abort(), 120000);

  let finalizeResp;
  try {
    finalizeResp = await fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Origin': 'https://notebooklm.google.com',
        'Referer': 'https://notebooklm.google.com/',
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': '0',
        'x-goog-authuser': String(authuserIndex),
      },
      body: fileBlob,
      signal: finalizeController.signal,
    });
    clearTimeout(finalizeTimeoutId);
  } catch (finErr) {
    clearTimeout(finalizeTimeoutId);
    if (finErr.name === 'AbortError') {
      const e = new Error('TIMEOUT'); e.code = 'TIMEOUT'; throw e;
    }
    throw finErr;
  }

  // P1.5 — Vérification auth sur l'étape finalize
  if (finalizeResp.status === 401 || finalizeResp.status === 403) {
    const e = new Error('AUTH_EXPIRED'); e.code = 'AUTH_EXPIRED'; throw e;
  }

  if (!finalizeResp.ok) {
    throw new Error(`HTTP ${finalizeResp.status}`);
  }
}

function getLastDebugInfo() {
  return {
    rawText: _lastRawText,
    bytesLength: _lastBytesLength,
    chunksLength: _lastChunksLength,
    error: _lastError,
  };
}

// Exposition globale (MV2 — background scripts partagent le même scope global)
// eslint-disable-next-line no-unused-vars
var NtcRpc = {
  listNotebooks,
  createNotebook,
  addTextSource,
  uploadFileSource,
  getLastDebugInfo,
};
