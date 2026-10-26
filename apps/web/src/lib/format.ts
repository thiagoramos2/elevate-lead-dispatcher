import type { DistributionStatus, LeadStatus } from '@elevate/contracts';

const TIMEZONE = 'America/Sao_Paulo';

const dateTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const integer = new Intl.NumberFormat('pt-BR');
const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 1 });

export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));
export const formatInteger = (value: number) => integer.format(value);
export const formatPercent = (value: number) => percent.format(value);

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'Novo',
  contacted: 'Contatado',
  no_answer: 'Sem resposta',
  callback: 'Retornar',
  qualified: 'Qualificado',
  sale: 'Venda',
  refund: 'Reembolso',
  invalid: 'Inválido',
};

export const DISTRIBUTION_LABEL: Record<DistributionStatus, string> = {
  pending: 'Aguardando',
  distributed: 'Distribuído',
  failed: 'Falhou',
};
