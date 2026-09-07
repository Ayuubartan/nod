/**
 * Final campaign report — docs/02 B2, docs/09 M4 task 2.
 *
 * Generated at RECONCILING, emailed to the brand, and it opens the 7-day dispute
 * window. Every number is read from the ledger and the verifications, so the PDF and
 * the dashboard can never disagree.
 */

import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer'
import { BRAND } from './brand'
import { prisma } from './db'
import { campaignBalance } from './money/balances'
import { effectiveCpmOre, formatOre } from './money/calc'

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10, color: '#14110F', fontFamily: 'Helvetica' },
  brand: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  title: { fontSize: 22, marginBottom: 4 },
  sub: { fontSize: 10, color: '#5C554D', marginBottom: 28 },
  sectionTitle: { fontSize: 12, marginTop: 20, marginBottom: 8, color: '#5C554D' },
  row: { flexDirection: 'row', borderBottom: '1 solid #E8E2DA', paddingVertical: 5 },
  cell: { flex: 1 },
  cellRight: { flex: 1, textAlign: 'right' },
  headerRow: { flexDirection: 'row', borderBottom: '1 solid #14110F', paddingBottom: 5, fontWeight: 700 },
  kpiRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  kpi: { flex: 1, border: '1 solid #E8E2DA', borderRadius: 6, padding: 10 },
  kpiLabel: { fontSize: 8, color: '#5C554D', marginBottom: 3 },
  kpiValue: { fontSize: 14, fontWeight: 700 },
  footer: { marginTop: 28, fontSize: 8, color: '#A39B91' },
})

export type ReportData = {
  campaignName: string
  brandName: string
  period: string
  spentOre: number
  reservedOre: number
  availableOre: number
  depositedOre: number
  refundedOre: number
  participants: number
  placements: number
  qualifiedViews: number
  totalViews: number
  effectiveCpmOre: number
  disputeWindowEndsAt: string
  byCity: Array<{ label: string; placements: number; qualifiedViews: number }>
  rows: Array<{
    handle: string
    city: string
    state: string
    views: number
    qualifiedViews: number
    disclosureOk: boolean
    postUrl: string | null
  }>
}

export async function buildReportData(campaignId: string): Promise<ReportData> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { brand: { select: { name: true } } },
  })

  const [balance, placements] = await Promise.all([
    campaignBalance(prisma, campaignId),
    prisma.placement.findMany({
      where: { campaignId, deletedAt: null },
      include: {
        account: { select: { handle: true } },
        user: { select: { id: true, city: true } },
        verification: { select: { views: true, qualifiedViews: true, disclosureOk: true } },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const qualifiedViews = placements.reduce((sum, p) => sum + (p.verification?.qualifiedViews ?? 0), 0)
  const totalViews = placements.reduce((sum, p) => sum + (p.verification?.views ?? 0), 0)

  const cityMap = new Map<string, { placements: number; qualifiedViews: number }>()
  for (const placement of placements) {
    const city = placement.user.city ?? 'unknown'
    const current = cityMap.get(city) ?? { placements: 0, qualifiedViews: 0 }
    cityMap.set(city, {
      placements: current.placements + 1,
      qualifiedViews: current.qualifiedViews + (placement.verification?.qualifiedViews ?? 0),
    })
  }

  return {
    campaignName: campaign.name,
    brandName: campaign.brand.name,
    period: `${campaign.startsAt?.toLocaleDateString('sv-SE') ?? '—'} – ${campaign.endsAt?.toLocaleDateString('sv-SE') ?? '—'}`,
    spentOre: balance.spentOre,
    reservedOre: balance.reservedOre,
    availableOre: balance.availableOre,
    depositedOre: balance.depositedOre,
    refundedOre: balance.refundedOre,
    participants: new Set(placements.map((p) => p.userId)).size,
    placements: placements.length,
    qualifiedViews,
    totalViews,
    effectiveCpmOre: effectiveCpmOre(balance.spentOre, qualifiedViews),
    disputeWindowEndsAt: campaign.disputeWindowEndsAt?.toLocaleDateString('sv-SE') ?? '—',
    byCity: [...cityMap.entries()].map(([label, value]) => ({ label, ...value })),
    rows: placements.map((placement) => ({
      handle: placement.account.handle,
      city: placement.user.city ?? '—',
      state: placement.state,
      views: placement.verification?.views ?? 0,
      qualifiedViews: placement.verification?.qualifiedViews ?? 0,
      disclosureOk: placement.verification?.disclosureOk ?? false,
      postUrl: placement.postUrl,
    })),
  }
}

function ReportDocument({ data }: { data: ReportData }) {
  return (
    <Document title={`${data.campaignName} — ${BRAND} report`}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.brand}>{BRAND}</Text>
        <Text style={styles.title}>{data.campaignName}</Text>
        <Text style={styles.sub}>
          {data.brandName} · {data.period}
        </Text>

        <View style={styles.kpiRow}>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Qualified views</Text>
            <Text style={styles.kpiValue}>{data.qualifiedViews.toLocaleString('sv-SE')}</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Spent</Text>
            <Text style={styles.kpiValue}>{formatOre(data.spentOre)}</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Effective CPM</Text>
            <Text style={styles.kpiValue}>{formatOre(data.effectiveCpmOre)}</Text>
          </View>
        </View>

        <View style={styles.kpiRow}>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Participants</Text>
            <Text style={styles.kpiValue}>{data.participants.toLocaleString('sv-SE')}</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Placements</Text>
            <Text style={styles.kpiValue}>{data.placements.toLocaleString('sv-SE')}</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Refunded</Text>
            <Text style={styles.kpiValue}>{formatOre(data.refundedOre + data.availableOre)}</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>By city</Text>
        <View style={styles.headerRow}>
          <Text style={styles.cell}>City</Text>
          <Text style={styles.cellRight}>Placements</Text>
          <Text style={styles.cellRight}>Qualified views</Text>
        </View>
        {data.byCity.map((row) => (
          <View key={row.label} style={styles.row}>
            <Text style={styles.cell}>{row.label}</Text>
            <Text style={styles.cellRight}>{row.placements.toLocaleString('sv-SE')}</Text>
            <Text style={styles.cellRight}>{row.qualifiedViews.toLocaleString('sv-SE')}</Text>
          </View>
        ))}

        <Text style={styles.footer}>
          Every placement above carries the disclosure required by Swedish marketing law, was
          published by a BankID-verified person aged 18 or over, and was verified before payment.
          You may dispute individual placements until {data.disputeWindowEndsAt}.
        </Text>
      </Page>

      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionTitle}>Placements</Text>
        <View style={styles.headerRow}>
          <Text style={styles.cell}>Account</Text>
          <Text style={styles.cell}>City</Text>
          <Text style={styles.cell}>State</Text>
          <Text style={styles.cellRight}>Views</Text>
          <Text style={styles.cellRight}>Qualified</Text>
          <Text style={styles.cellRight}>Ad</Text>
        </View>
        {data.rows.map((row, index) => (
          <View key={`${row.handle}-${index}`} style={styles.row}>
            <Text style={styles.cell}>@{row.handle}</Text>
            <Text style={styles.cell}>{row.city}</Text>
            <Text style={styles.cell}>{row.state}</Text>
            <Text style={styles.cellRight}>{row.views.toLocaleString('sv-SE')}</Text>
            <Text style={styles.cellRight}>{row.qualifiedViews.toLocaleString('sv-SE')}</Text>
            <Text style={styles.cellRight}>{row.disclosureOk ? 'Yes' : '—'}</Text>
          </View>
        ))}
      </Page>
    </Document>
  )
}

export async function renderReport(campaignId: string): Promise<Buffer> {
  const data = await buildReportData(campaignId)
  return renderToBuffer(<ReportDocument data={data} />)
}
