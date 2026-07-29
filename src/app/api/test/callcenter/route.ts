import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

/**
 * POST /api/test/callcenter
 *
 * Seeds test data for the call center:
 * - 3 test contacts (João, Maria, Pedro)
 * - Conversations with messages simulating real scenarios
 * - Tags (suporte, vendas, financeiro, urgente)
 * - 2 triage automations (greeting, keyword routing)
 * - 1 test flow (call center menu)
 *
 * Safe to re-run (idempotent — skips existing rows).
 */
export async function POST() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )

    const uid = user.id
    const results: Record<string, unknown> = {}

    // ─── Tags ───
    const tagDefs = [
      { name: 'suporte', color: '#3b82f6' },
      { name: 'vendas', color: '#22c55e' },
      { name: 'financeiro', color: '#f59e0b' },
      { name: 'urgente', color: '#ef4444' },
    ]

    const tagIds: Record<string, string> = {}
    for (const tag of tagDefs) {
      const { data: existing } = await admin
        .from('tags')
        .select('id')
        .eq('user_id', uid)
        .eq('name', tag.name)
        .maybeSingle()

      if (existing) {
        tagIds[tag.name] = existing.id
      } else {
        const { data: created } = await admin
          .from('tags')
          .insert({ user_id: uid, ...tag })
          .select('id')
          .single()
        if (created) tagIds[tag.name] = created.id
      }
    }
    results.tags = tagIds

    // ─── Contacts ───
    const contactDefs = [
      { phone: '+5511999887766', name: 'João Silva', company: 'TechCorp' },
      { phone: '+5511988776655', name: 'Maria Santos', company: 'Loja Online' },
      { phone: '+5511977665544', name: 'Pedro Costa', company: 'StartupXYZ' },
    ]

    const contactIds: string[] = []
    for (const c of contactDefs) {
      const { data: existing } = await admin
        .from('contacts')
        .select('id')
        .eq('user_id', uid)
        .eq('phone', c.phone)
        .maybeSingle()

      if (existing) {
        contactIds.push(existing.id)
      } else {
        const { data: created } = await admin
          .from('contacts')
          .insert({ user_id: uid, ...c })
          .select('id')
          .single()
        if (created) contactIds.push(created.id)
      }
    }
    results.contacts = contactIds

    // ─── Conversations + Messages ───
    const scenarios = [
      {
        contactIndex: 0,
        tag: 'suporte',
        messages: [
          { sender: 'customer', text: 'Oi, preciso de ajuda com meu login' },
          { sender: 'bot', text: 'Olá João! Vou te ajudar. Pode me descrever o problema?' },
          { sender: 'customer', text: 'Não consigo acessar minha conta, diz senha incorreta' },
          { sender: 'bot', text: 'Já tentou redefinir sua senha pelo link "Esqueci minha senha"?' },
          { sender: 'customer', text: 'Sim, mas não recebo o email de redefinição' },
          { sender: 'bot', text: 'Entendo. Verifique sua caixa de spam. Se não encontrar, posso handoff para um especialista.' },
          { sender: 'customer', text: 'Já verifiquei, não tem nada lá. Preciso de ajuda urgente!' },
        ],
      },
      {
        contactIndex: 1,
        tag: 'vendas',
        messages: [
          { sender: 'customer', text: 'Olá, gostaria de saber sobre os planos' },
          { sender: 'bot', text: 'Olá Maria! Temos 3 planos: Básico, Profissional e Empresarial. Qual te interessa?' },
          { sender: 'customer', text: 'O profissional, quanto custa?' },
          { sender: 'bot', text: 'O plano Profissional é R$ 99/mês com todas as funcionalidades. Quer que eu te envie os detalhes?' },
          { sender: 'customer', text: 'Sim, por favor. E tem desconto anual?' },
        ],
      },
      {
        contactIndex: 2,
        tag: 'urgente',
        messages: [
          { sender: 'customer', text: 'SEU SISTEMA ESTÁ CAÍDO! Não consigo processar nenhuma venda!' },
          { sender: 'bot', text: 'Pedro, sinto muito pelo inconveniente. Vou verificar imediatamente.' },
          { sender: 'customer', text: 'Isso é URGENTE, estou perdendo dinheiro a cada minuto!' },
          { sender: 'bot', text: 'Entendo a urgência. Escalando para nossa equipe técnica agora.' },
          { sender: 'customer', text: 'Preciso que resolva AGORA, já abri chamado antes e nada foi feito!' },
        ],
      },
    ]

    const convIds: string[] = []
    for (const scenario of scenarios) {
      const contactId = contactIds[scenario.contactIndex]
      if (!contactId) continue

      // Check existing conversation
      const { data: existingConv } = await admin
        .from('conversations')
        .select('id')
        .eq('user_id', uid)
        .eq('contact_id', contactId)
        .maybeSingle()

      let convId = existingConv?.id

      if (!convId) {
        const { data: newConv } = await admin
          .from('conversations')
          .insert({
            user_id: uid,
            contact_id: contactId,
            status: 'open',
            last_message_text: scenario.messages[scenario.messages.length - 1].text,
            last_message_at: new Date().toISOString(),
          })
          .select('id')
          .single()
        convId = newConv?.id
      }

      if (!convId) continue
      convIds.push(convId)

      // Add tag to contact
      if (tagIds[scenario.tag] && contactId) {
        const { data: existingTag } = await admin
          .from('contact_tags')
          .select('id')
          .eq('contact_id', contactId)
          .eq('tag_id', tagIds[scenario.tag])
          .maybeSingle()

        if (!existingTag) {
          await admin.from('contact_tags').insert({
            contact_id: contactId,
            tag_id: tagIds[scenario.tag],
          })
        }
      }

      // Skip if messages already exist
      const { count } = await admin
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('conversation_id', convId)

      if (count && count > 0) continue

      // Insert messages
      const now = Date.now()
      const msgs = scenario.messages.map((m, i) => ({
        conversation_id: convId,
        sender_type: m.sender,
        sender_id: m.sender === 'customer' ? contactId : uid,
        content_type: 'text',
        content_text: m.text,
        message_id: `test_${convId}_${i}`,
        status: 'delivered',
        created_at: new Date(now + i * 60000).toISOString(),
      }))

      await admin.from('messages').insert(msgs)
    }
    results.conversations = convIds

    // ─── Automations ───
    // 1. Greeting automation — sends interactive menu on first inbound message
    const { data: existingGreeting } = await admin
      .from('automations')
      .select('id')
      .eq('user_id', uid)
      .eq('name', 'Call Center - Saudação')
      .maybeSingle()

    if (!existingGreeting) {
      const { data: greetingAuto } = await admin
        .from('automations')
        .insert({
          user_id: uid,
          name: 'Call Center - Saudação',
          description: 'Envia menu interativo na primeira mensagem do cliente',
          trigger_type: 'first_inbound_message',
          trigger_config: {},
          is_active: true,
        })
        .select('id')
        .single()

      if (greetingAuto) {
        await admin.from('automation_steps').insert([
          {
            automation_id: greetingAuto.id,
            step_type: 'send_buttons',
            step_config: {
              body: 'Olá! Bem-vindo ao nosso atendimento. Como podemos ajudar?',
              buttons: [
                { id: 'suporte', title: '🔧 Suporte' },
                { id: 'vendas', title: '💰 Vendas' },
                { id: 'financeiro', title: '📋 Financeiro' },
              ],
            },
            position: 0,
          },
          {
            automation_id: greetingAuto.id,
            step_type: 'condition',
            step_config: {
              field: 'interactive_reply_id',
              operator: 'equals',
              value: 'suporte',
            },
            position: 1,
          },
        ])
      }
      results.greetingAutomation = greetingAuto?.id
    }

    // 2. Keyword routing — detects urgency keywords and adds tag + sends escalation message
    const { data: existingRouting } = await admin
      .from('automations')
      .select('id')
      .eq('user_id', uid)
      .eq('name', 'Call Center - Roteamento Urgente')
      .maybeSingle()

    if (!existingRouting) {
      const { data: routingAuto } = await admin
        .from('automations')
        .insert({
          user_id: uid,
          name: 'Call Center - Roteamento Urgente',
          description: 'Detecta palavras urgentes e escala para admin',
          trigger_type: 'keyword_match',
          trigger_config: { keywords: ['urgente', 'problema', 'erro', 'caiu', 'parou'] },
          is_active: true,
        })
        .select('id')
        .single()

      if (routingAuto) {
        await admin.from('automation_steps').insert([
          {
            automation_id: routingAuto.id,
            step_type: 'add_tag',
            step_config: { tag_id: tagIds['urgente'] },
            position: 0,
          },
          {
            automation_id: routingAuto.id,
            step_type: 'send_message',
            step_config: { text: 'Detectamos que sua situação é urgente. Estamos escalando para um especialista.' },
            position: 1,
          },
        ])
      }
      results.routingAutomation = routingAuto?.id
    }

    // ─── Flow: Call Center Menu ───
    const { data: existingFlow } = await admin
      .from('flows')
      .select('id')
      .eq('user_id', uid)
      .eq('name', 'Call Center Menu')
      .maybeSingle()

    if (!existingFlow) {
      const { data: flow } = await admin
        .from('flows')
        .insert({
          user_id: uid,
          name: 'Call Center Menu',
          description: 'Flow interativo de atendimento com menu e triagem',
          status: 'active',
          trigger_type: 'keyword',
          trigger_config: { keywords: ['atendimento', 'ajuda', 'suporte'] },
          entry_node_id: 'start',
          fallback_policy: { on_unknown_reply: 'reprompt', max_reprompts: 2, on_timeout_hours: 24, on_exhaust: 'handoff' },
        })
        .select('id')
        .single()

      if (flow) {
        await admin.from('flow_nodes').insert([
          {
            flow_id: flow.id,
            node_key: 'start',
            node_type: 'start',
            config: {},
            position_x: 0,
            position_y: 0,
          },
          {
            flow_id: flow.id,
            node_key: 'welcome',
            node_type: 'send_message',
            config: { text: 'Bem-vindo ao atendimento! Vou te ajudar.' },
            position_x: 200,
            position_y: 0,
          },
          {
            flow_id: flow.id,
            node_key: 'menu',
            node_type: 'send_buttons',
            config: {
              body: 'Escolha uma opção:',
              buttons: [
                { id: 'tech', title: '🔧 Suporte Técnico' },
                { id: 'sales', title: '💰 Comercial' },
                { id: 'other', title: '📋 Outros' },
              ],
            },
            position_x: 400,
            position_y: 0,
          },
          {
            flow_id: flow.id,
            node_key: 'collect',
            node_type: 'collect_input',
            config: { prompt: 'Descreva brevemente seu problema ou dúvida:' },
            position_x: 600,
            position_y: 0,
          },
          {
            flow_id: flow.id,
            node_key: 'handoff',
            node_type: 'handoff',
            config: { message: 'Vou transferir para um especialista. Aguarde um momento.' },
            position_x: 800,
            position_y: 0,
          },
        ])
        results.flow = flow.id
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Call center test data seeded successfully',
      results,
    })
  } catch (error) {
    console.error('[test/callcenter] seed error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
