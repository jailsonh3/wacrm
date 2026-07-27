// ============================================================
// Evolution API client — REST wrapper for WhatsApp via Baileys
//
// Provides functions to manage instances and send messages
// through the Evolution API v2.3.7.
// ============================================================

import { decrypt } from '@/lib/whatsapp/encryption';

export interface EvolutionSendResult {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
  };
  message?: Record<string, unknown>;
  messageTimestamp?: string;
  status?: string;
}

interface EvolutionApiError {
  success: boolean;
  error: {
    code: string;
    message: string;
  };
  meta?: {
    timestamp: string;
    path: string;
    method: string;
  };
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

async function evolutionFetch<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    apikey: apiKey,
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const apiError = errorBody as EvolutionApiError | null;
    throw new Error(
      apiError?.error?.message ||
        `Evolution API error: ${response.status} ${response.statusText}`
    );
  }

  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------
// Instance management
// ---------------------------------------------------------------

export interface EvolutionInstance {
  instanceName: string;
  instanceId: string;
  integration: string;
  status: string;
  hash?: string;
  qrcode?: {
    pairingCode: string | null;
    code: string;
    base64: string;
    count: number;
  };
}

export interface EvolutionInstanceInfo {
  id: string;
  name?: string;
  instanceName?: string;
  token: string;
  webhook: string;
  connected: boolean;
  qrcode: string;
  jid: string;
  os_name: string;
  client_name: string;
  createdAt: string;
  alwaysOnline: boolean;
  rejectCall: boolean;
  msgRejectCall: string;
  readMessages: boolean;
  ignoreGroups: boolean;
  ignoreStatus: boolean;
}

/**
 * Create a new Evolution API instance for a WhatsApp account.
 * v2.3.7 response: { instance, hash, webhook, websocket, rabbitmq, nats, sqs, settings, qrcode }
 */
export async function createEvolutionInstance(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  number?: string;
  integration?: string;
  webhookUrl?: string;
  webhookEvents?: string[];
}): Promise<EvolutionInstance> {
  const {
    baseUrl,
    apiKey,
    instanceName,
    number,
    integration = 'WHATSAPP-BAILEYS',
    webhookUrl,
    webhookEvents = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
  } = params;

  const raw = await evolutionFetch<{
    instance?: { instanceName: string; instanceId: string; integration: string; status: string };
    hash?: string;
    qrcode?: { pairingCode: string | null; code: string; base64: string; count: number };
  }>(baseUrl, apiKey, '/instance/create', {
    method: 'POST',
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration,
      number,
      webhook: webhookUrl
        ? {
            enabled: true,
            url: webhookUrl,
            events: webhookEvents,
          }
        : undefined,
    }),
  });

  return {
    instanceName: raw.instance?.instanceName ?? instanceName,
    instanceId: raw.instance?.instanceId ?? '',
    integration: raw.instance?.integration ?? integration,
    status: raw.instance?.status ?? 'connecting',
    hash: raw.hash,
    qrcode: raw.qrcode,
  };
}

/**
 * Get all Evolution API instances.
 * v2.3.7 response: array of instance objects
 */
export async function getEvolutionInstances(params: {
  baseUrl: string;
  apiKey: string;
}): Promise<EvolutionInstanceInfo[]> {
  const { baseUrl, apiKey } = params;
  const result = await evolutionFetch<EvolutionInstanceInfo[]>(
    baseUrl,
    apiKey,
    '/instance/fetchInstances'
  );
  return Array.isArray(result) ? result : [];
}

/**
 * Get connection state of an Evolution instance.
 * v2.3.7 response: { instance: { instanceName, state } }
 */
export async function getEvolutionInstanceState(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
}): Promise<{ state: string; statusReason?: number }> {
  const { baseUrl, apiKey, instanceName } = params;
  const raw = await evolutionFetch<{
    instance?: { instanceName: string; state: string };
    state?: string;
    statusReason?: number;
  }>(baseUrl, apiKey, `/instance/connectionState/${instanceName}`);

  // v2.3.7 wraps in { instance: { state } } but handle flat too
  const state = raw.instance?.state ?? raw.state ?? 'close';
  return { state, statusReason: raw.statusReason };
}

/**
 * Get QR code for connecting an Evolution instance.
 * v2.3.7 response when connecting: { pairingCode, code, base64, count }
 * v2.3.7 response when already connected: { instance: { instanceName, state: "open" } }
 */
export async function getEvolutionQrCode(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
}): Promise<{ base64: string; code: string; count: number; alreadyConnected?: boolean }> {
  const { baseUrl, apiKey, instanceName } = params;
  const raw = await evolutionFetch<{
    pairingCode?: string | null;
    code?: string;
    base64?: string;
    count?: number;
    instance?: { instanceName: string; state: string };
  }>(baseUrl, apiKey, `/instance/connect/${instanceName}`);

  // Already connected — no QR code needed
  if (raw.instance?.state === 'open') {
    return { base64: '', code: '', count: 0, alreadyConnected: true };
  }

  return {
    base64: raw.base64 ?? '',
    code: raw.code ?? '',
    count: raw.count ?? 0,
    alreadyConnected: false,
  };
}

/**
 * Connect an Evolution instance using a pairing code (phone number).
 * v2.3.7 response: { pairingCode, code, base64 } or { instance: { state: "open" } }
 */
export async function connectEvolutionInstance(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  number: string;
}): Promise<{ pairingCode: string | null; code: string; base64: string; alreadyConnected?: boolean }> {
  const { baseUrl, apiKey, instanceName, number } = params;
  const raw = await evolutionFetch<{
    pairingCode?: string | null;
    code?: string;
    base64?: string;
    instance?: { instanceName: string; state: string };
  }>(
    baseUrl,
    apiKey,
    `/instance/connect/${instanceName}`,
    {
      method: 'POST',
      body: JSON.stringify({ number }),
    }
  );

  // Already connected
  if (raw.instance?.state === 'open') {
    return { pairingCode: null, code: '', base64: '', alreadyConnected: true };
  }

  return {
    pairingCode: raw.pairingCode ?? null,
    code: raw.code ?? '',
    base64: raw.base64 ?? '',
    alreadyConnected: false,
  };
}

/**
 * Disconnect and delete an Evolution instance.
 */
export async function disconnectEvolutionInstance(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
}): Promise<void> {
  const { baseUrl, apiKey, instanceName } = params;
  await evolutionFetch(baseUrl, apiKey, `/instance/delete/${instanceName}`, {
    method: 'DELETE',
  });
}

/**
 * Set or update the webhook URL for an Evolution instance.
 * v2.3.7 expects flat body: { enabled, url, events } (NOT nested under "webhook")
 */
export async function setEvolutionWebhook(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  webhookUrl: string;
  webhookEvents?: string[];
}): Promise<unknown> {
  const { baseUrl, apiKey, instanceName, webhookUrl, webhookEvents = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] } = params;
  return evolutionFetch<unknown>(baseUrl, apiKey, `/webhook/set/${instanceName}`, {
    method: 'POST',
    body: JSON.stringify({
      enabled: true,
      url: webhookUrl,
      events: webhookEvents,
    }),
  });
}

/**
 * Fetch a single instance's info (includes webhook config).
 */
export async function fetchEvolutionInstance(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
}): Promise<EvolutionInstanceInfo | null> {
  const instances = await getEvolutionInstances(params);
  return instances.find(
    (i) => (i.name ?? i.instanceName) === params.instanceName
  ) ?? null;
}

// ---------------------------------------------------------------
// Message sending
// ---------------------------------------------------------------

/**
 * Send a text message via Evolution API.
 * v2.3.7 request: { number, textMessage: { text }, delay?, linkPreview?, quoted? }
 */
export async function sendEvolutionTextMessage(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  number: string;
  text: string;
  delay?: number;
  linkPreview?: boolean;
  quoted?: {
    key: { id: string };
    message: { conversation: string };
  };
}): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, number, text, delay, linkPreview, quoted } =
    params;

  return evolutionFetch<EvolutionSendResult>(
    baseUrl,
    apiKey,
    `/message/sendText/${instanceName}`,
    {
      method: 'POST',
      body: JSON.stringify({
        number,
        textMessage: { text },
        delay,
        linkPreview,
        quoted,
      }),
    }
  );
}

/**
 * Send a media message (image, video, document, audio) via Evolution API.
 */
export async function sendEvolutionMediaMessage(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  number: string;
  mediatype: 'image' | 'video' | 'document' | 'audio';
  media: string; // URL or base64
  caption?: string;
  fileName?: string;
  mimetype?: string;
  delay?: number;
  quoted?: {
    key: { id: string };
    message: { conversation: string };
  };
}): Promise<EvolutionSendResult> {
  const {
    baseUrl,
    apiKey,
    instanceName,
    number,
    mediatype,
    media,
    caption,
    fileName,
    mimetype,
    delay,
    quoted,
  } = params;

  return evolutionFetch<EvolutionSendResult>(
    baseUrl,
    apiKey,
    `/message/sendMedia/${instanceName}`,
    {
      method: 'POST',
      body: JSON.stringify({
        number,
        mediatype,
        media,
        caption,
        fileName,
        mimetype,
        delay,
        quoted,
      }),
    }
  );
}

/**
 * Send a location message via Evolution API.
 */
export async function sendEvolutionLocationMessage(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  number: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, number, name, address, latitude, longitude } =
    params;

  return evolutionFetch<EvolutionSendResult>(
    baseUrl,
    apiKey,
    `/message/sendLocation/${instanceName}`,
    {
      method: 'POST',
      body: JSON.stringify({
        number,
        name,
        address,
        latitude,
        longitude,
      }),
    }
  );
}

/**
 * Send a contact vCard via Evolution API.
 */
export async function sendEvolutionContactMessage(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  number: string;
  contactName: string;
  contactPhone: string;
}): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, number, contactName, contactPhone } = params;

  return evolutionFetch<EvolutionSendResult>(
    baseUrl,
    apiKey,
    `/message/sendContacts/${instanceName}`,
    {
      method: 'POST',
      body: JSON.stringify({
        number,
        contactName,
        contactPhone,
      }),
    }
  );
}

/**
 * Send a reaction to a message via Evolution API.
 */
export async function sendEvolutionReaction(params: {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
  number: string;
  messageId: string;
  emoji: string;
}): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instanceName, number, messageId, emoji } = params;

  return evolutionFetch<EvolutionSendResult>(
    baseUrl,
    apiKey,
    `/message/sendReaction/${instanceName}`,
    {
      method: 'POST',
      body: JSON.stringify({
        number,
        messageId,
        emoji,
      }),
    }
  );
}

// ---------------------------------------------------------------
// Decrypted config helper
// ---------------------------------------------------------------

/**
 * Get decrypted Evolution API credentials from a config row.
 */
export function getEvolutionCredentials(config: {
  evolution_api_url: string | null;
  evolution_api_key: string | null;
  evolution_instance_name: string | null;
}): {
  baseUrl: string;
  apiKey: string;
  instanceName: string;
} | null {
  if (!config.evolution_api_url || !config.evolution_api_key || !config.evolution_instance_name) {
    return null;
  }

  return {
    baseUrl: config.evolution_api_url,
    apiKey: decrypt(config.evolution_api_key),
    instanceName: config.evolution_instance_name,
  };
}
