import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { groupBy, isEmpty, keyBy, last, sortBy } from 'lodash'
import { getValues, log, logMemory, writeAsync } from './utils'
import { Bet } from '../../common/bet'
import { Contract, CPMM } from '../../common/contract'

import { PortfolioMetrics, User } from '../../common/user'
import { DAY_MS } from '../../common/util/time'
import { getLoanUpdates } from '../../common/loans'
import { scoreTraders, scoreCreators } from '../../common/scoring'
import {
  calculateCreatorVolume,
  calculateNewPortfolioMetrics,
  calculateNewProfit,
  calculateProbChanges,
  computeVolume,
} from '../../common/calculate-metrics'
import { getProbability } from '../../common/calculate'
import { Group } from 'common/group'

const firestore = admin.firestore()

export const updateMetrics = functions
  .runWith({ memory: '2GB', timeoutSeconds: 540 })
  .pubsub.schedule('every 15 minutes')
  .onRun(updateMetricsCore)

export async function updateMetricsCore() {
  const [users, contracts, bets, allPortfolioHistories, groups] =
    await Promise.all([
      getValues<User>(firestore.collection('users')),
      getValues<Contract>(firestore.collection('contracts')),
      getValues<Bet>(firestore.collectionGroup('bets')),
      getValues<PortfolioMetrics>(
        firestore
          .collectionGroup('portfolioHistory')
          .where('timestamp', '>', Date.now() - 31 * DAY_MS) // so it includes just over a month ago
      ),
      getValues<Group>(firestore.collection('groups')),
    ])

  const contractsByGroup = await Promise.all(
    groups.map((group) => {
      return getValues(
        firestore
          .collection('groups')
          .doc(group.id)
          .collection('groupContracts')
      )
    })
  )
  log(
    `Loaded ${users.length} users, ${contracts.length} contracts, and ${bets.length} bets.`
  )
  logMemory()

  const now = Date.now()
  const betsByContract = groupBy(bets, (bet) => bet.contractId)

  const contractUpdates = contracts
    .filter((contract) => contract.id)
    .map((contract) => {
      const contractBets = betsByContract[contract.id] ?? []
      const descendingBets = sortBy(
        contractBets,
        (bet) => bet.createdTime
      ).reverse()

      let cpmmFields: Partial<CPMM> = {}
      if (contract.mechanism === 'cpmm-1') {
        const prob = descendingBets[0]
          ? descendingBets[0].probAfter
          : getProbability(contract)

        cpmmFields = {
          prob,
          probChanges: calculateProbChanges(descendingBets),
        }
      }

      return {
        doc: firestore.collection('contracts').doc(contract.id),
        fields: {
          volume24Hours: computeVolume(contractBets, now - DAY_MS),
          volume7Days: computeVolume(contractBets, now - DAY_MS * 7),
          ...cpmmFields,
        },
      }
    })
  await writeAsync(firestore, contractUpdates)
  log(`Updated metrics for ${contracts.length} contracts.`)

  const contractsById = Object.fromEntries(
    contracts.map((contract) => [contract.id, contract])
  )
  const contractsByUser = groupBy(contracts, (contract) => contract.creatorId)
  const betsByUser = groupBy(bets, (bet) => bet.userId)
  const portfolioHistoryByUser = groupBy(allPortfolioHistories, (p) => p.userId)

  const userMetrics = users.map((user) => {
    const currentBets = betsByUser[user.id] ?? []
    const portfolioHistory = portfolioHistoryByUser[user.id] ?? []
    const userContracts = contractsByUser[user.id] ?? []
    const newCreatorVolume = calculateCreatorVolume(userContracts)
    const newPortfolio = calculateNewPortfolioMetrics(
      user,
      contractsById,
      currentBets
    )
    const lastPortfolio = last(portfolioHistory)
    const didPortfolioChange =
      lastPortfolio === undefined ||
      lastPortfolio.balance !== newPortfolio.balance ||
      lastPortfolio.totalDeposits !== newPortfolio.totalDeposits ||
      lastPortfolio.investmentValue !== newPortfolio.investmentValue

    const newProfit = calculateNewProfit(portfolioHistory, newPortfolio)

    return {
      user,
      newCreatorVolume,
      newPortfolio,
      newProfit,
      didPortfolioChange,
    }
  })

  const portfolioByUser = Object.fromEntries(
    userMetrics.map(({ user, newPortfolio }) => [user.id, newPortfolio])
  )
  const { userPayouts } = getLoanUpdates(
    users,
    contractsById,
    portfolioByUser,
    betsByUser
  )
  const nextLoanByUser = keyBy(userPayouts, (payout) => payout.user.id)

  const userUpdates = userMetrics.map(
    ({
      user,
      newCreatorVolume,
      newPortfolio,
      newProfit,
      didPortfolioChange,
    }) => {
      const nextLoanCached = nextLoanByUser[user.id]?.payout ?? 0
      return {
        fieldUpdates: {
          doc: firestore.collection('users').doc(user.id),
          fields: {
            creatorVolumeCached: newCreatorVolume,
            profitCached: newProfit,
            nextLoanCached,
          },
        },

        subcollectionUpdates: {
          doc: firestore
            .collection('users')
            .doc(user.id)
            .collection('portfolioHistory')
            .doc(),
          fields: didPortfolioChange ? newPortfolio : {},
        },
      }
    }
  )
  await writeAsync(
    firestore,
    userUpdates.map((u) => u.fieldUpdates)
  )
  await writeAsync(
    firestore,
    userUpdates
      .filter((u) => !isEmpty(u.subcollectionUpdates.fields))
      .map((u) => u.subcollectionUpdates),
    'set'
  )
  log(`Updated metrics for ${users.length} users.`)

  try {
    const groupUpdates = groups.map((group, index) => {
      const groupContractIds = contractsByGroup[index] as GroupContractDoc[]
      const groupContracts = groupContractIds.map(
        (e) => contractsById[e.contractId]
      )
      const bets = groupContracts.map((e) => {
        if (e != null && e.id in betsByContract) {
          return betsByContract[e.id] ?? []
        } else {
          return []
        }
      })

      const creatorScores = scoreCreators(groupContracts)
      const traderScores = scoreTraders(groupContracts, bets)

      const topTraderScores = topUserScores(traderScores)
      const topCreatorScores = topUserScores(creatorScores)

      return {
        doc: firestore.collection('groups').doc(group.id),
        fields: {
          cachedLeaderboard: {
            topTraders: topTraderScores,
            topCreators: topCreatorScores,
          },
        },
      }
    })
    // Shipping without this for now to check it's working as intended
    console.log('Group Leaderboard Updates', groupUpdates)
    //await writeAsync(firestore, groupUpdates)
  } catch (e) {
    console.log('Error While Updating Group Leaderboards', e)
  }
}

const topUserScores = (scores: { [userId: string]: number }) => {
  const top50 = Object.entries(scores)
    .sort(([, scoreA], [, scoreB]) => scoreB - scoreA)
    .slice(0, 50)
  return top50.map(([userId, score]) => ({ userId, score }))
}

type GroupContractDoc = { contractId: string; createdTime: number }
