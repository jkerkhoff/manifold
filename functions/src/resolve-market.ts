import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import * as _ from 'lodash'

import { Contract } from '../../common/contract'
import { User } from '../../common/user'
import { Bet } from '../../common/bet'
import { getUser, payUser } from './utils'
import { sendMarketResolutionEmail } from './emails'
import { getPayouts, getPayoutsMultiOutcome } from '../../common/payouts'

export const resolveMarket = functions
  .runWith({ minInstances: 1 })
  .https.onCall(
    async (
      data: {
        outcome: string
        contractId: string
        probabilityInt?: number
        resolutions?: { [outcome: string]: number }
      },
      context
    ) => {
      const userId = context?.auth?.uid
      if (!userId) return { status: 'error', message: 'Not authorized' }

      const { outcome, contractId, probabilityInt, resolutions } = data

      const contractDoc = firestore.doc(`contracts/${contractId}`)
      const contractSnap = await contractDoc.get()
      if (!contractSnap.exists)
        return { status: 'error', message: 'Invalid contract' }
      const contract = contractSnap.data() as Contract
      const { creatorId, outcomeType } = contract

      if (outcomeType === 'BINARY') {
        if (!['YES', 'NO', 'MKT', 'CANCEL'].includes(outcome))
          return { status: 'error', message: 'Invalid outcome' }
      } else if (outcomeType === 'FREE_RESPONSE') {
        if (
          isNaN(+outcome) &&
          !(outcome === 'MKT' && resolutions) &&
          outcome !== 'CANCEL'
        )
          return { status: 'error', message: 'Invalid outcome' }
      } else {
        return { status: 'error', message: 'Invalid contract outcomeType' }
      }

      if (
        outcomeType === 'BINARY' &&
        probabilityInt !== undefined &&
        (probabilityInt < 0 ||
          probabilityInt > 100 ||
          !isFinite(probabilityInt))
      )
        return { status: 'error', message: 'Invalid probability' }

      if (creatorId !== userId)
        return { status: 'error', message: 'User not creator of contract' }

      if (contract.resolution)
        return { status: 'error', message: 'Contract already resolved' }

      const creator = await getUser(creatorId)
      if (!creator) return { status: 'error', message: 'Creator not found' }

      const resolutionProbability =
        probabilityInt !== undefined ? probabilityInt / 100 : undefined

      await contractDoc.update({
        isResolved: true,
        resolution: outcome,
        resolutionTime: Date.now(),
        ...(resolutionProbability === undefined
          ? {}
          : { resolutionProbability }),
        ...(resolutions === undefined ? {} : { resolutions }),
      })

      console.log('contract ', contractId, 'resolved to:', outcome)

      const betsSnap = await firestore
        .collection(`contracts/${contractId}/bets`)
        .get()

      const bets = betsSnap.docs.map((doc) => doc.data() as Bet)
      const openBets = bets.filter((b) => !b.isSold && !b.sale)

      const payouts =
        outcomeType === 'FREE_RESPONSE' && resolutions
          ? getPayoutsMultiOutcome(resolutions, contract as any, openBets)
          : getPayouts(outcome, contract, openBets, resolutionProbability)

      console.log('payouts:', payouts)

      const groups = _.groupBy(payouts, (payout) => payout.userId)
      const userPayouts = _.mapValues(groups, (group) =>
        _.sumBy(group, (g) => g.payout)
      )

      const payoutPromises = Object.entries(userPayouts).map(
        ([userId, payout]) => payUser(userId, payout)
      )

      const result = await Promise.all(payoutPromises)
        .catch((e) => ({ status: 'error', message: e }))
        .then(() => ({ status: 'success' }))

      await sendResolutionEmails(
        openBets,
        userPayouts,
        creator,
        contract,
        outcome,
        resolutionProbability,
        resolutions
      )

      return result
    }
  )

const sendResolutionEmails = async (
  openBets: Bet[],
  userPayouts: { [userId: string]: number },
  creator: User,
  contract: Contract,
  outcome: string,
  resolutionProbability?: number,
  resolutions?: { [outcome: string]: number }
) => {
  const nonWinners = _.difference(
    _.uniq(openBets.map(({ userId }) => userId)),
    Object.keys(userPayouts)
  )
  const emailPayouts = [
    ...Object.entries(userPayouts),
    ...nonWinners.map((userId) => [userId, 0] as const),
  ]
  await Promise.all(
    emailPayouts.map(([userId, payout]) =>
      sendMarketResolutionEmail(
        userId,
        payout,
        creator,
        contract,
        outcome,
        resolutionProbability,
        resolutions
      )
    )
  )
}

const firestore = admin.firestore()
