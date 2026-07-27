import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { findExistingContact } from '@/lib/contacts/dedupe';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

// Lazy-initialized admin client (any-typed to avoid schema inference issues)
let _adminClient: SupabaseClient | null = null;
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

// ---------------------------------------------------------------
// Evolution API webhook event types
// ---------------------------------------------------------------

interface EvolutionWebhookEvent {
  event: string;
  instance: string;
  data: {
    key: {
      remoteJid: string;
      fromMe: boolean;
      id: string;
    };
    pushName?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text: string };
      imageMessage?: { url: string; mimetype: string; caption?: string };
      videoMessage?: { url: string; mimetype: string; caption?: string };
      documentMessage?: { url: string; mimetype: string; fileName?: string; caption?: string };
      audioMessage?: { url: string; mimetype: string };
      stickerMessage?: { url: string; mimetype: string };
      locationMessage?: { degreesLatitude: number; degreesLongitude: number; name?: string; address?: string };
      reactionMessage?: { key: { id: string }; emoji: string };
      buttonsResponseMessage?: { selectedButtonId: string; contextInfo: { stanzaId: string } };
      listResponseMessage?: { singleSelectReply: { selectedRowId: string }; contextInfo: { stanzaId: string } };
    };
    messageTimestamp?: number;
    status?: string;
  };
}

// ---------------------------------------------------------------
// POST — Receive webhook events from Evolution API
// ---------------------------------------------------------------

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const events = Array.isArray(body) ? body : [body];

    // Process each event asynchronously
    for (const event of events) {
      await processEvolutionEvent(event);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[evolution-webhook] Error processing webhook:', error);
    return NextResponse.json({ ok: true }); // Always return 200 to prevent retries
  }
}

// ---------------------------------------------------------------
// GET — Health check / verification
// ---------------------------------------------------------------

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    provider: 'evolution',
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------

async function processEvolutionEvent(event: EvolutionWebhookEvent) {
  const { event: eventType, instance, data } = event;

  if (eventType === 'messages.upsert') {
    await handleMessageUpsert(instance, data);
  } else if (eventType === 'connection.update') {
    await handleConnectionUpdate(instance, data as { state?: string; statusReason?: number });
  }
}

async function handleMessageUpsert(
  instanceName: string,
  data: EvolutionWebhookEvent['data']
) {
  const { key, message, messageTimestamp } = data;

  // Skip messages we sent (fromMe = true)
  if (key.fromMe) return;

  const admin = supabaseAdmin();

  // Find the WhatsApp config for this instance
  const { data: config, error: configError } = await admin
    .from('whatsapp_config')
    .select('*')
    .eq('evolution_instance_name', instanceName)
    .eq('provider', 'evolution')
    .maybeSingle();

  if (configError || !config) {
    console.warn(
      `[evolution-webhook] No config found for instance: ${instanceName}`
    );
    return;
  }

  const accountId = config.account_id as string;
  const userId = config.user_id as string;

  // Extract phone number from remoteJid (remove @s.whatsapp.net)
  const phone = key.remoteJid.replace(/@.*$/, '');
  const normalizedPhone = normalizePhone(phone);

  // Find or create contact
  const contact = await findExistingContact(admin, accountId, normalizedPhone);

  let contactId: string;
  let contactWasCreated = false;

  if (contact) {
    contactId = contact.id;
  } else {
    // Create new contact
    const { data: newContact, error: contactError } = await admin
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: userId,
        phone: normalizedPhone,
        name: data.pushName || null,
      })
      .select('id')
      .single();

    if (contactError || !newContact) {
      console.error('[evolution-webhook] Failed to create contact:', contactError);
      return;
    }

    contactId = newContact.id;
    contactWasCreated = true;
  }

  // Find or create conversation (oldest-first, unique per account+contact)
  const { data: existingConversations } = await admin
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  let conversationId: string;

  if (existingConversations && existingConversations.length > 0) {
    conversationId = existingConversations[0].id;
  } else {
    // Create new conversation
    const { data: newConversation, error: convError } = await admin
      .from('conversations')
      .insert({
        account_id: accountId,
        contact_id: contactId,
        user_id: userId,
        status: 'open',
        last_message_text: extractMessageText(message),
        last_message_at: new Date(
          (messageTimestamp ?? Date.now() / 1000) * 1000
        ).toISOString(),
      })
      .select('id')
      .single();

    if (convError || !newConversation) {
      console.error('[evolution-webhook] Failed to create conversation:', convError);
      return;
    }

    conversationId = newConversation.id;

    // Dispatch new contact automation
    await runAutomationsForTrigger({
      accountId,
      triggerType: 'new_contact_created',
      contactId,
    });

    await dispatchWebhookEvent(admin, accountId, 'conversation.created', {
      conversationId,
      contactId,
    });
  }

  // Extract message content
  const content = extractMessageContent(message);
  if (!content) return;

  // Determine message type
  const contentType = determineContentType(message);

  // Check if this is the first inbound message
  const { count } = await admin
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer');

  const isFirstInboundMessage = count === 0;

  // Persist message
  const { data: savedMessage, error: msgError } = await admin
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'customer',
      sender_id: contactId,
      content_type: contentType,
      content_text: content.text,
      media_url: content.mediaUrl,
      message_id: key.id,
      status: 'delivered',
      created_at: new Date(
        (messageTimestamp ?? Date.now() / 1000) * 1000
      ).toISOString(),
    })
    .select('id')
    .single();

  if (msgError) {
    console.error('[evolution-webhook] Failed to save message:', msgError);
    return;
  }

  // Update conversation metadata
  await admin
    .from('conversations')
    .update({
      last_message_text: content.text ?? content.caption ?? '[media]',
      last_message_at: new Date(
        (messageTimestamp ?? Date.now() / 1000) * 1000
      ).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Dispatch to flows (awaited - need result before automations)
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId,
    contactId,
    conversationId,
    message: {
      kind: 'text',
      text: content.text ?? '',
      meta_message_id: key.id,
    },
    isFirstInboundMessage,
  });

  const flowConsumed = flowResult.consumed;

  // Fire automations (fire-and-forget)
  const inboundText = content.text ?? '';
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = [];

  // Content-level triggers are suppressed when a flow consumed the message
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
  }

  // Contact-level triggers
  if (contactWasCreated) automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message');

  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context: {
        message_text: inboundText,
        conversation_id: conversationId,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }

  // AI auto-reply (only if flow didn't consume and there's text)
  if (!flowConsumed && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId,
      contactId,
      configOwnerUserId: userId,
    });
  }

  // Webhook event
  await dispatchWebhookEvent(admin, accountId, 'message.received', {
    messageId: savedMessage.id,
    conversationId,
    contactId,
    text: content.text,
    from: normalizedPhone,
  });
}

async function handleConnectionUpdate(
  instanceName: string,
  data: { state?: string; statusReason?: number }
) {
  const admin = supabaseAdmin();
  const { state } = data;

  const status = state === 'open' ? 'connected' : 'disconnected';

  await admin
    .from('whatsapp_config')
    .update({
      status,
      connected_at: state === 'open' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('evolution_instance_name', instanceName)
    .eq('provider', 'evolution');
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

interface MessageContent {
  text?: string;
  caption?: string;
  mediaUrl?: string;
}

function extractMessageContent(
  message: EvolutionWebhookEvent['data']['message']
): MessageContent | null {
  if (!message) return null;

  // Text messages
  if (message.conversation) {
    return { text: message.conversation };
  }
  if (message.extendedTextMessage) {
    return { text: message.extendedTextMessage.text };
  }

  // Media messages
  if (message.imageMessage) {
    return {
      text: message.imageMessage.caption,
      mediaUrl: message.imageMessage.url,
    };
  }
  if (message.videoMessage) {
    return {
      text: message.videoMessage.caption,
      mediaUrl: message.videoMessage.url,
    };
  }
  if (message.documentMessage) {
    return {
      text: message.documentMessage.caption,
      mediaUrl: message.documentMessage.url,
    };
  }
  if (message.audioMessage) {
    return { mediaUrl: message.audioMessage.url };
  }
  if (message.stickerMessage) {
    return { mediaUrl: message.stickerMessage.url };
  }

  // Location
  if (message.locationMessage) {
    const { degreesLatitude, degreesLongitude, name, address } =
      message.locationMessage;
    return {
      text: `${name ? name + '\n' : ''}${address || ''}\n${degreesLatitude}, ${degreesLongitude}`,
    };
  }

  // Reaction (ignore for now, just log)
  if (message.reactionMessage) {
    return null; // Reactions are handled separately
  }

  // Interactive responses
  if (message.buttonsResponseMessage) {
    return { text: message.buttonsResponseMessage.selectedButtonId };
  }
  if (message.listResponseMessage) {
    return {
      text: message.listResponseMessage.singleSelectReply.selectedRowId,
    };
  }

  return null;
}

function extractMessageText(
  message: EvolutionWebhookEvent['data']['message']
): string | null {
  if (!message) return null;

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;

  return null;
}

function determineContentType(
  message: EvolutionWebhookEvent['data']['message']
): string {
  if (!message) return 'text';

  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.documentMessage) return 'document';
  if (message.audioMessage) return 'audio';
  if (message.stickerMessage) return 'image'; // Treat stickers as images
  if (message.locationMessage) return 'location';

  return 'text';
}
