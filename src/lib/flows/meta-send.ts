import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import {
  sendEvolutionTextMessage,
  sendEvolutionMediaMessage,
  getEvolutionCredentials,
} from '@/lib/whatsapp/evolution-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { supabaseAdmin } from './admin-client'
import type { WhatsAppProvider } from '@/types'

// ------------------------------------------------------------
// Flows-side sender — supports both Meta and Evolution providers.
//
// Each public function checks config.provider and routes to the
// appropriate API. Evolution doesn't support interactive buttons/
// lists or templates, so those fall back to plain text.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
  aiGenerated?: boolean
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const provider: WhatsAppProvider = config.provider || 'meta'
  let waMessageId = ''

  if (provider === 'evolution') {
    const credentials = getEvolutionCredentials(config)
    if (!credentials) throw new Error('Evolution API credentials not configured')

    const result = await sendEvolutionTextMessage({
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      instanceName: credentials.instanceName,
      number: sanitized,
      text: args.text,
    })
    waMessageId = result.key.id
  } else {
    const accessToken = decrypt(config.access_token)
    const attempt = async (phone: string): Promise<string> => {
      const r = await sendTextMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        text: args.text,
      })
      return r.messageId
    }

    const variants = phoneVariants(sanitized)
    let lastError: unknown = null
    for (const v of variants) {
      try {
        waMessageId = await attempt(v)
        lastError = null
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!isRecipientNotAllowedError(msg)) throw err
        lastError = err
      }
    }
    if (lastError) throw lastError
  }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
  if (msgErr) {
    throw new Error(`DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const provider: WhatsAppProvider = config.provider || 'meta'
  let waMessageId = ''

  if (provider === 'evolution') {
    const credentials = getEvolutionCredentials(config)
    if (!credentials) throw new Error('Evolution API credentials not configured')

    const mimetypeMap: Record<string, string> = {
      audio: 'audio/ogg',
      image: 'image/jpeg',
      video: 'video/mp4',
      document: 'application/pdf',
    }

    const result = await sendEvolutionMediaMessage({
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      instanceName: credentials.instanceName,
      number: sanitized,
      mediatype: args.kind as 'image' | 'video' | 'document' | 'audio',
      media: args.link,
      caption: args.caption,
      fileName: args.filename,
      mimetype: mimetypeMap[args.kind] || undefined,
    })
    waMessageId = result.key.id
  } else {
    const accessToken = decrypt(config.access_token)
    const attempt = async (phone: string): Promise<string> => {
      const r = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
      })
      return r.messageId
    }

    const variants = phoneVariants(sanitized)
    let lastError: unknown = null
    for (const v of variants) {
      try {
        waMessageId = await attempt(v)
        lastError = null
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!isRecipientNotAllowedError(msg)) throw err
        lastError = err
      }
    }
    if (lastError) throw lastError
  }

  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const provider: WhatsAppProvider = config.provider || 'meta'
  let waMessageId = ''

  // Evolution API doesn't support interactive buttons/lists —
  // fall back to sending the body text as a plain message.
  if (provider === 'evolution') {
    const credentials = getEvolutionCredentials(config)
    if (!credentials) throw new Error('Evolution API credentials not configured')

    const result = await sendEvolutionTextMessage({
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      instanceName: credentials.instanceName,
      number: sanitized,
      text: input.bodyText,
    })
    waMessageId = result.key.id
  } else {
    const accessToken = decrypt(config.access_token)
    const attempt = async (phone: string): Promise<string> => {
      if (input.kind === 'buttons') {
        const r = await sendInteractiveButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to: phone,
          bodyText: input.bodyText,
          buttons: input.buttons,
          headerText: input.headerText,
          footerText: input.footerText,
        })
        return r.messageId
      }
      const r = await sendInteractiveList({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        bodyText: input.bodyText,
        buttonLabel: input.buttonLabel,
        sections: input.sections,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      return r.messageId
    }

    const variants = phoneVariants(sanitized)
    let lastError: unknown = null
    for (const v of variants) {
      try {
        waMessageId = await attempt(v)
        lastError = null
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!isRecipientNotAllowedError(msg)) throw err
        lastError = err
      }
    }
    if (lastError) throw lastError
  }

  const interactivePayload: InteractiveMessagePayload =
    input.kind === 'buttons'
      ? {
          kind: 'buttons',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          buttons: input.buttons,
        }
      : {
          kind: 'list',
          body: input.bodyText,
          header: input.headerText,
          footer: input.footerText,
          button_label: input.buttonLabel,
          sections: input.sections,
        }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: input.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}
