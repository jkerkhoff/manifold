import { DotsHorizontalIcon } from '@heroicons/react/outline'
import clsx from 'clsx'
import dayjs from 'dayjs'
import { uniqBy } from 'lodash'
import { useState } from 'react'
import { Bet } from 'common/bet'

import { Contract } from 'common/contract'
import { formatMoney } from 'common/util/format'
import {
  contractPath,
  contractPool,
  getBinaryProbPercent,
} from 'web/lib/firebase/contracts'
import { LiquidityPanel } from '../liquidity-panel'
import { CopyLinkButton } from '../copy-link-button'
import { Col } from '../layout/col'
import { Modal } from '../layout/modal'
import { Row } from '../layout/row'
import { ShareEmbedButton } from '../share-embed-button'
import { TagsInput } from '../tags-input'
import { Title } from '../title'
import { TweetButton } from '../tweet-button'

export function ContractInfoDialog(props: { contract: Contract; bets: Bet[] }) {
  const { contract, bets } = props

  const [open, setOpen] = useState(false)

  const formatTime = (dt: number) => dayjs(dt).format('MMM DD, YYYY hh:mm a z')

  const { createdTime, closeTime, resolutionTime } = contract
  const tradersCount = uniqBy(
    bets.filter((bet) => !bet.isAnte),
    'userId'
  ).length

  return (
    <>
      <button
        className="group flex items-center rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:cursor-pointer hover:bg-gray-100"
        onClick={() => setOpen(true)}
      >
        <DotsHorizontalIcon
          className={clsx(
            'h-6 w-6 flex-shrink-0 text-gray-400 group-hover:text-gray-500'
          )}
          aria-hidden="true"
        />
      </button>

      <Modal open={open} setOpen={setOpen}>
        <Col className="gap-4 rounded bg-white p-6">
          <Title className="!mt-0 !mb-0" text="Market info" />

          <div>Share</div>

          <Row className="justify-start gap-4">
            <CopyLinkButton
              contract={contract}
              toastClassName={'sm:-left-10 -left-4 min-w-[250%]'}
            />
            <TweetButton
              className="self-start"
              tweetText={getTweetText(contract, false)}
            />
            <ShareEmbedButton contract={contract} toastClassName={'-left-20'} />
          </Row>
          <div />

          <div>Stats</div>
          <table className="table-compact table-zebra table w-full text-gray-500">
            <tbody>
              <tr>
                <td>Market created</td>
                <td>{formatTime(createdTime)}</td>
              </tr>

              {closeTime && (
                <tr>
                  <td>Market close{closeTime > Date.now() ? 's' : 'd'}</td>
                  <td>{formatTime(closeTime)}</td>
                </tr>
              )}

              {resolutionTime && (
                <tr>
                  <td>Market resolved</td>
                  <td>{formatTime(resolutionTime)}</td>
                </tr>
              )}

              <tr>
                <td>Volume</td>
                <td>{formatMoney(contract.volume)}</td>
              </tr>

              <tr>
                <td>Creator earnings</td>
                <td>{formatMoney(contract.collectedFees.creatorFee)}</td>
              </tr>

              <tr>
                <td>Traders</td>
                <td>{tradersCount}</td>
              </tr>

              <tr>
                <td>Pool</td>
                <td>{contractPool(contract)}</td>
              </tr>
            </tbody>
          </table>

          <div>Tags</div>
          <TagsInput contract={contract} />
          <div />

          {contract.mechanism === 'cpmm-1' && !contract.resolution && (
            <LiquidityPanel contract={contract} />
          )}
        </Col>
      </Modal>
    </>
  )
}

const getTweetText = (contract: Contract, isCreator: boolean) => {
  const { question, creatorName, resolution, outcomeType } = contract
  const isBinary = outcomeType === 'BINARY'

  const tweetQuestion = isCreator
    ? question
    : `${question}\nAsked by ${creatorName}.`
  const tweetDescription = resolution
    ? `Resolved ${resolution}!`
    : isBinary
    ? `Currently ${getBinaryProbPercent(
        contract
      )} chance, place your bets here:`
    : `Submit your own answer:`

  const timeParam = `${Date.now()}`.substring(7)
  const url = `https://manifold.markets${contractPath(contract)}?t=${timeParam}`

  return `${tweetQuestion}\n\n${tweetDescription}\n\n${url}`
}
