import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  getEvolutionInstanceState,
  disconnectEvolutionInstance,
  getEvolutionCredentials,
} from '@/lib/whatsapp/evolution-api';

let _adminClient: ReturnType<typeof createAdminClient> | null = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

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
// GET — Check Evolution instance status
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
      return NextResponse.json({ connected: false, configured: false, message: 'No account found' }, { status: 200 });
    }

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'evolution')
      .maybeSingle();

    if (!config) {
      return NextResponse.json({ connected: false, configured: false, message: 'Evolution API not configured' });
    }

    const credentials = getEvolutionCredentials(config);
    if (!credentials) {
      return NextResponse.json({ connected: false, configured: true, message: 'Evolution API credentials missing' });
    }

    try {
      const instanceState = await getEvolutionInstanceState({
        baseUrl: credentials.baseUrl,
        apiKey: credentials.apiKey,
        instanceName: credentials.instanceName,
      });

      const isConnected = instanceState.state === 'open';

      if (config.status !== (isConnected ? 'connected' : 'disconnected')) {
        await supabase
          .from('whatsapp_config')
          .update({
            status: isConnected ? 'connected' : 'disconnected',
            connected_at: isConnected ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', config.id);
      }

      return NextResponse.json({
        connected: isConnected,
        configured: true,
        status: instanceState.state,
        instanceName: credentials.instanceName,
        statusReason: instanceState.statusReason,
      });
    } catch (error) {
      console.warn('[evolution-config] Failed to check instance state:', error);
      // Instance might not exist yet — return disconnected
      return NextResponse.json({
        connected: false,
        configured: true,
        status: 'unknown',
        instanceName: credentials.instanceName,
        message: error instanceof Error ? error.message : 'Failed to check status',
      });
    }
  } catch (error) {
    console.error('[evolution-config] GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------
// POST — Save Evolution API configuration
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
    const { evolution_api_url, evolution_api_key, evolution_instance_name } = body;

    if (!evolution_api_url || !evolution_api_key || !evolution_instance_name) {
      return NextResponse.json(
        { error: 'Missing required fields: evolution_api_url, evolution_api_key, evolution_instance_name' },
        { status: 400 },
      );
    }

    const { data: existingConfig } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('provider', 'evolution')
      .maybeSingle();

    const encryptedApiKey = encrypt(evolution_api_key);

    if (existingConfig) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update({
          evolution_api_url,
          evolution_api_key: encryptedApiKey,
          evolution_instance_name,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingConfig.id);

      if (updateError) {
        console.error('[evolution-config] Update error:', updateError);
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 });
      }
    } else {
      const { data: metaConfig } = await supabase
        .from('whatsapp_config')
        .select('phone_number_id')
        .eq('account_id', accountId)
        .eq('provider', 'meta')
        .maybeSingle();

      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          phone_number_id: metaConfig?.phone_number_id || 'evolution-pending',
          access_token: encrypt('evolution-placeholder'),
          provider: 'evolution',
          evolution_api_url,
          evolution_api_key: encryptedApiKey,
          evolution_instance_name,
          status: 'disconnected',
        });

      if (insertError) {
        console.error('[evolution-config] Insert error:', insertError);
        return NextResponse.json({ error: 'Failed to create configuration' }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, message: 'Evolution API configuration saved' });
  } catch (error) {
    console.error('[evolution-config] POST error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------
// DELETE — Remove Evolution API configuration
// ---------------------------------------------------------------

export async function DELETE() {
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
      return NextResponse.json({ error: 'No Evolution config found' }, { status: 404 });
    }

    // Only remove the config from DB — do NOT delete the Evolution instance
    // The user's WhatsApp instance stays alive on Evolution API

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', config.id);

    if (deleteError) {
      console.error('[evolution-config] Delete error:', deleteError);
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 });
    }

    return NextResponse.json({ success: true, message: 'Evolution API configuration deleted' });
  } catch (error) {
    console.error('[evolution-config] DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
