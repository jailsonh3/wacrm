import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  createEvolutionInstance,
  getEvolutionQrCode,
  connectEvolutionInstance,
  setEvolutionWebhook,
  getEvolutionCredentials,
} from '@/lib/whatsapp/evolution-api';

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data?.account_id) return null;
  return data.account_id as string;
}

// ---------------------------------------------------------------
// GET — Get QR code for connecting instance
// ---------------------------------------------------------------

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json({ error: 'No account found' }, { status: 404 });
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'evolution')
      .maybeSingle();

    if (!config) {
      return NextResponse.json({ error: 'Evolution API not configured' }, { status: 404 });
    }

    const credentials = getEvolutionCredentials(config);
    if (!credentials) {
      return NextResponse.json({ error: 'Missing Evolution API credentials' }, { status: 400 });
    }

    const webhookUrl = `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/api/evolution-webhook`;

    try {
      // Always ensure webhook is configured — even for existing instances
      const webhookResult = await setEvolutionWebhook({
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
        instanceName: credentials.instanceName,
        webhookUrl,
      }).catch((err) => {
        console.warn('[evolution-connect] Webhook set failed (non-fatal):', err);
        return null;
      });

      console.log('[evolution-connect] Webhook configured:', {
        url: webhookUrl,
        byEvents: false,
        result: webhookResult,
      });

      const qrCode = await getEvolutionQrCode({
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
        instanceName: credentials.instanceName,
      });

      // Already connected — no QR needed
      if (qrCode.alreadyConnected) {
        await supabase
          .from('whatsapp_config')
          .update({
            status: 'connected',
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', config.id);

        return NextResponse.json({
          success: true,
          alreadyConnected: true,
          message: 'Instance is already connected',
        });
      }

      return NextResponse.json({
        success: true,
        qrcode: qrCode.base64,
        code: qrCode.code,
        count: qrCode.count,
      });
    } catch {
      // Instance doesn't exist yet — create it
      try {
        const newInstance = await createEvolutionInstance({
          baseUrl: credentials.baseUrl,
          apiKey: credentials.apiKey,
          instanceName: credentials.instanceName,
          webhookUrl,
        });

        // Set webhook explicitly on new instance
        await setEvolutionWebhook({
          baseUrl: credentials.baseUrl,
          apiKey: credentials.apiKey,
          instanceName: credentials.instanceName,
          webhookUrl,
        }).catch(() => {});

        await supabase
          .from('whatsapp_config')
          .update({
            phone_number_id: credentials.instanceName,
            updated_at: new Date().toISOString(),
          })
          .eq('id', config.id);

        return NextResponse.json({
          success: true,
          qrcode: newInstance.qrcode?.base64 ?? '',
          code: newInstance.qrcode?.code ?? '',
          count: newInstance.qrcode?.count ?? 1,
          instance: newInstance.instanceName,
        });
      } catch (createError) {
        console.error('[evolution-connect] Failed to create instance:', createError);
        return NextResponse.json(
          {
            error:
              createError instanceof Error
                ? createError.message
                : 'Failed to create Evolution instance',
          },
          { status: 500 },
        );
      }
    }
  } catch (error) {
    console.error('[evolution-connect] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------
// POST — Connect instance using pairing code
// ---------------------------------------------------------------

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json({ error: 'No account found' }, { status: 404 });
    }

    const body = await request.json();
    const { number } = body;

    if (!number) {
      return NextResponse.json({ error: 'Phone number is required' }, { status: 400 });
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'evolution')
      .maybeSingle();

    if (!config) {
      return NextResponse.json({ error: 'Evolution API not configured' }, { status: 404 });
    }

    const credentials = getEvolutionCredentials(config);
    if (!credentials) {
      return NextResponse.json({ error: 'Missing Evolution API credentials' }, { status: 400 });
    }

    try {
      const result = await connectEvolutionInstance({
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
        instanceName: credentials.instanceName,
        number,
      });

      // Already connected
      if (result.alreadyConnected) {
        await supabase
          .from('whatsapp_config')
          .update({
            phone_number_id: credentials.instanceName,
            status: 'connected',
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', config.id);

        return NextResponse.json({
          success: true,
          alreadyConnected: true,
          message: 'Instance is already connected',
        });
      }

      await supabase
        .from('whatsapp_config')
        .update({
          phone_number_id: credentials.instanceName,
          updated_at: new Date().toISOString(),
        })
        .eq('id', config.id);

      return NextResponse.json({
        success: true,
        pairingCode: result.pairingCode,
        code: result.code,
        qrcode: result.base64,
      });
    } catch (error) {
      console.error('[evolution-connect] POST error:', error);
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Failed to connect instance',
        },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error('[evolution-connect] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
