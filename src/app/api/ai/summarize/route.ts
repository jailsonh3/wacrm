import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'

interface SummaryResult {
  summary: string
  sentiment: 'positive' | 'neutral' | 'negative' | 'angry'
  category: string
  urgency: 'low' | 'medium' | 'high' | 'critical'
  key_points: string[]
  suggested_action: string
}

const SUMMARY_PROMPT = `You are a call center supervisor. Summarize this WhatsApp conversation for the agent taking over.

Analyze the conversation and return ONLY a valid JSON object (no markdown, no code fences) with these fields:
- summary: 2-3 sentence summary of what happened
- sentiment: "positive" | "neutral" | "negative" | "angry"
- category: main topic (e.g., "technical_support", "billing", "sales", "complaint", "general_inquiry")
- urgency: "low" | "medium" | "high" | "critical"
- key_points: array of 2-5 key points discussed
- suggested_action: what the agent should do first

Conversation:
`

/**
 * POST /api/ai/summarize  (agent+)
 *
 * Body: { conversation_id }
 * Returns: { summary, sentiment, category, urgency, key_points, suggested_action }
 *
 * Generates an AI summary of the conversation for the agent taking over.
 * Saves the summary to conversations.ai_handoff_summary.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent')

    const body = await request.json().catch(() => null)
    const conversationId =
      body && typeof body.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      )
    }

    // Load conversation
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id, ai_handoff_summary')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/summarize] conversation lookup error:', convErr)
      return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 })
    }
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    // If summary already exists, return it
    if (conversation.ai_handoff_summary) {
      try {
        const parsed = JSON.parse(conversation.ai_handoff_summary)
        return NextResponse.json(parsed)
      } catch {
        // Not JSON — return as plain text summary
        return NextResponse.json({
          summary: conversation.ai_handoff_summary,
          sentiment: 'neutral',
          category: 'general',
          urgency: 'medium',
          key_points: [],
          suggested_action: 'Review the conversation and assist the customer.',
        })
      }
    }

    // Load AI config
    const config = await loadAiConfig(supabase, accountId).catch((err) => {
      console.error('[ai/summarize] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'AI assistant is not set up. Enable it in Settings → AI Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    // Fetch last 30 messages (include all types for context)
    const { data: dbMessages, error: msgErr } = await supabase
      .from('messages')
      .select('sender_type, content_text, content_type, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(30)

    if (msgErr) {
      console.error('[ai/summarize] messages fetch error:', msgErr)
      return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 })
    }

    const messages = (dbMessages ?? [])
      .filter((m) => m.content_text && m.content_text.trim())
      .reverse()
      .map((m) => ({
        role: m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const),
        content: `[${m.sender_type}] ${m.content_text!.trim()}`,
      }))

    if (messages.length === 0) {
      return NextResponse.json({
        summary: 'No messages in this conversation yet.',
        sentiment: 'neutral',
        category: 'general',
        urgency: 'low',
        key_points: [],
        suggested_action: 'Wait for the customer to send a message.',
      })
    }

    // Generate summary
    const { text, usage } = await generateReply({
      config,
      systemPrompt: SUMMARY_PROMPT,
      messages,
    })

    // Parse the JSON response
    let summary: SummaryResult
    try {
      // Strip markdown code fences if present
      const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
      summary = JSON.parse(cleaned)
    } catch {
      // If parsing fails, use the raw text as summary
      summary = {
        summary: text,
        sentiment: 'neutral',
        category: 'general',
        urgency: 'medium',
        key_points: [],
        suggested_action: 'Review the conversation and assist the customer.',
      }
    }

    // Save to conversation
    const summaryJson = JSON.stringify(summary)
    await supabase
      .from('conversations')
      .update({ ai_handoff_summary: summaryJson })
      .eq('id', conversationId)

    // Log usage
    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
      })
    } catch (logErr) {
      console.error('[ai/summarize] usage log skipped:', logErr)
    }

    return NextResponse.json(summary)
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
