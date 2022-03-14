const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, prepareTransaction } = require('../src/index')
const { toFixedHex } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(process.env.MINIMUM_WITHDRAWAL_AMOUNT || '0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(process.env.MAXIMUM_DEPOSIT_AMOUNT || '1')

async function deploy(contractName, ...args) {
  const Factory = await ethers.getContractFactory(contractName)
  const instance = await Factory.deploy(...args)
  return instance.deployed()
}

async function fixture() {
  require('../scripts/compileHasher')
  const hasher = await deploy('Hasher')

  const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()

  const verifier2 = await deploy('Verifier2')
  const verifier16 = await deploy('Verifier16')

  const merkleTreeWithHistory = await deploy('MerkleTreeWithHistoryMock', MERKLE_TREE_HEIGHT, hasher.address)
  await merkleTreeWithHistory.initialize()

  const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
  await token.mint(sender.address, utils.parseEther('10000'))

  const amb = await deploy('MockAMB', gov.address, l1ChainId)
  const omniBridge = await deploy('MockOmniBridge', amb.address)

  /** @type {TornadoPool} */
  const tornadoPoolImpl = await deploy(
    'TornadoPool',
    verifier2.address,
    verifier16.address,
    MERKLE_TREE_HEIGHT,
    hasher.address,
    token.address,
    omniBridge.address,
    l1Unwrapper.address,
    gov.address,
    l1ChainId,
    multisig.address,
  )

  const { data } = await tornadoPoolImpl.populateTransaction.initialize(
    MINIMUM_WITHDRAWAL_AMOUNT,
    MAXIMUM_DEPOSIT_AMOUNT,
  )
  const proxy = await deploy(
    'CrossChainUpgradeableProxy',
    tornadoPoolImpl.address,
    gov.address,
    data,
    amb.address,
    l1ChainId,
  )

  const tornadoPool = tornadoPoolImpl.attach(proxy.address)

  await token.approve(tornadoPool.address, utils.parseEther('10000'))

  return { tornadoPool, token, omniBridge, merkleTreeWithHistory }
}

it('Should estimate gas needed to insert a pair of leaves, deposit from L1 and withdraw to L2', async () => {
  const { merkleTreeWithHistory, tornadoPool, token, omniBridge } = await loadFixture(fixture)

  // Here it estimates the gas needed to insert a pair of leaves to MerkleTreeWithHistory
  const gas = await merkleTreeWithHistory.estimateGas.hashLeftRight(toFixedHex(123), toFixedHex(456))
  console.log('hasher gas', gas - 21000)

  // A pair of private and public keys are generated
  const L1Keypair = new Keypair()

  // L1 deposits into tornado pool
  const L1DepositAmount = utils.parseEther('0.08')
  const L1DepositUtxo = new Utxo({ amount: L1DepositAmount, keypair: L1Keypair })
  const { args, extData } = await prepareTransaction({
    tornadoPool,
    outputs: [L1DepositUtxo],
  })

  const onTokenBridgedData = encodeDataForBridge({
    proof: args,
    extData,
  })

  const onTokenBridgedTx = await tornadoPool.populateTransaction.onTokenBridged(
    token.address,
    L1DepositUtxo.amount,
    onTokenBridgedData,
  )
  // emulating bridge. first it sends tokens to omnibridge mock then it sends to the pool
  await token.transfer(omniBridge.address, L1DepositAmount)
  const transferTx = await token.populateTransaction.transfer(tornadoPool.address, L1DepositAmount)

  await omniBridge.execute([
    { who: token.address, callData: transferTx.data }, // send tokens to pool
    { who: tornadoPool.address, callData: onTokenBridgedTx.data }, // call onTokenBridgedTx
  ])

  // withdraws a part of his funds from the shielded pool
  const L2WithdrawAmount = utils.parseEther('0.05')
  const recipient = '0xDeaD00000000000000000000000000000000BEEf'
  const changeUtxo = new Utxo({
    amount: L1DepositAmount.sub(L2WithdrawAmount),
    keypair: L1Keypair,
  })
  await transaction({
    tornadoPool,
    inputs: [L1DepositUtxo],
    outputs: [changeUtxo],
    recipient: recipient,
    isL1Withdrawal: false,
  })

  // asserts recipient, omniBridge, and tornadoPool balances are correct
  const L2Balance = await token.balanceOf(recipient)
  expect(L2Balance).to.be.equal(utils.parseEther('0.05'))

  const L1Balance = await token.balanceOf(tornadoPool.address)
  expect(L1Balance).to.be.equal(utils.parseEther('0.03'))

  const omniBridgeBalance = await token.balanceOf(omniBridge.address)
  expect(omniBridgeBalance).to.be.equal(0)
})
