"use client";

import { useState, useCallback } from "react";
import {
  Sparkles,
  Copy,
  Check,
  RefreshCw,
  AlertTriangle,
  Clock,
  Zap,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SummaryData {
  summary: string;
  sentiment: "positive" | "neutral" | "negative" | "angry";
  category: string;
  urgency: "low" | "medium" | "high" | "critical";
  key_points: string[];
  suggested_action: string;
}

interface ConversationSummaryProps {
  conversationId: string;
  existingSummary?: string | null;
  onSummaryGenerated?: (summary: SummaryData) => void;
}

const SENTIMENT_CONFIG = {
  positive: { label: "Positivo", color: "text-green-400", bg: "bg-green-500/10" },
  neutral: { label: "Neutro", color: "text-blue-400", bg: "bg-blue-500/10" },
  negative: { label: "Negativo", color: "text-yellow-400", bg: "bg-yellow-500/10" },
  angry: { label: "Irado", color: "text-red-400", bg: "bg-red-500/10" },
};

const URGENCY_CONFIG = {
  low: { label: "Baixa", color: "text-green-400", icon: Clock },
  medium: { label: "Média", color: "text-yellow-400", icon: ArrowUpRight },
  high: { label: "Alta", color: "text-orange-400", icon: AlertTriangle },
  critical: { label: "Crítica", color: "text-red-400", icon: Zap },
};

const CATEGORY_LABELS: Record<string, string> = {
  technical_support: "Suporte Técnico",
  billing: "Financeiro",
  sales: "Vendas",
  complaint: "Reclamação",
  general_inquiry: "Consulta Geral",
  general: "Geral",
};

export function ConversationSummary({
  conversationId,
  existingSummary,
  onSummaryGenerated,
}: ConversationSummaryProps) {
  const [summary, setSummary] = useState<SummaryData | null>(() => {
    if (existingSummary) {
      try {
        return JSON.parse(existingSummary);
      } catch {
        return {
          summary: existingSummary,
          sentiment: "neutral",
          category: "general",
          urgency: "medium",
          key_points: [],
          suggested_action: "Review the conversation.",
        };
      }
    }
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setSummary(data);
      onSummaryGenerated?.(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to generate summary";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [conversationId, onSummaryGenerated]);

  const handleCopy = useCallback(async () => {
    if (!summary) return;
    const text = `Resumo: ${summary.summary}\n\nPontos-chave:\n${summary.key_points.map((p) => `- ${p}`).join("\n")}\n\nAção sugerida: ${summary.suggested_action}`;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [summary]);

  // Auto-generate if no summary exists
  if (!summary && !loading && !error) {
    generateSummary();
  }

  if (loading) {
    return (
      <Card className="border-border bg-muted/30">
        <CardContent className="py-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            Gerando resumo da conversa...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-border bg-muted/30">
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-red-400">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
            <Button variant="ghost" size="sm" onClick={generateSummary}>
              <RefreshCw className="h-3 w-3 mr-1" />
              Tentar novamente
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!summary) return null;

  const sentiment = SENTIMENT_CONFIG[summary.sentiment];
  const urgency = URGENCY_CONFIG[summary.urgency];
  const UrgencyIcon = urgency.icon;
  const category = CATEGORY_LABELS[summary.category] || summary.category;

  return (
    <Card className="border-border bg-muted/30">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Resumo AI
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              className="h-7 px-2"
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={generateSummary}
              className="h-7 px-2"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {/* Badges */}
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className={cn("text-xs", sentiment.color, sentiment.bg)}>
            {sentiment.label}
          </Badge>
          <Badge variant="outline" className={cn("text-xs", urgency.color)}>
            <UrgencyIcon className="h-3 w-3 mr-1" />
            Urgência {urgency.label}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {category}
          </Badge>
        </div>

        {/* Summary */}
        <p className="text-sm text-foreground leading-relaxed">{summary.summary}</p>

        {/* Key Points */}
        {summary.key_points.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Pontos-chave:</p>
            <ul className="text-xs text-foreground space-y-1">
              {summary.key_points.map((point, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="text-primary mt-0.5">•</span>
                  {point}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Suggested Action */}
        <div className="rounded-md bg-primary/5 border border-primary/20 px-3 py-2">
          <p className="text-xs font-medium text-primary mb-0.5">Ação sugerida:</p>
          <p className="text-xs text-foreground">{summary.suggested_action}</p>
        </div>
      </CardContent>
    </Card>
  );
}
