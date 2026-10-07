//! Building, assembling and signing Soroban contract calls.
//!
//! The flow for every call is: build an `InvokeHostFunction` transaction,
//! simulate it, then `assemble` the simulation's footprint, resource fee and
//! authorization entries into it, and `sign` it. Because the keeper is also
//! the transaction source, its `require_auth` is satisfied by source-account
//! credentials and needs no separate auth-entry signature.

use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use stellar_xdr::{
    AccountId, ContractId, DecoratedSignature, Hash, HostFunction, InvokeContractArgs,
    InvokeHostFunctionOp, Memo, MuxedAccount, Operation, OperationBody, Preconditions, PublicKey,
    ScAddress, ScSymbol, ScVal, SequenceNumber, Signature, SignatureHint,
    SorobanAuthorizationEntry, SorobanTransactionData, Transaction, TransactionEnvelope,
    TransactionExt, TransactionV1Envelope, Uint256, VecM,
};

pub type Error = Box<dyn std::error::Error + Send + Sync>;

pub fn account_address(key: &SigningKey) -> ScVal {
    ScVal::Address(ScAddress::Account(AccountId(
        PublicKey::PublicKeyTypeEd25519(Uint256(key.verifying_key().to_bytes())),
    )))
}

pub fn contract_address(id: [u8; 32]) -> ScAddress {
    ScAddress::Contract(ContractId(Hash(id)))
}

/// An unsigned call of `contract.function(args)` from `source` at `sequence`.
pub fn invoke(
    source: &SigningKey,
    sequence: i64,
    contract: [u8; 32],
    function: &str,
    args: Vec<ScVal>,
    inclusion_fee: u32,
) -> Result<Transaction, Error> {
    let op = Operation {
        source_account: None,
        body: OperationBody::InvokeHostFunction(InvokeHostFunctionOp {
            host_function: HostFunction::InvokeContract(InvokeContractArgs {
                contract_address: contract_address(contract),
                function_name: ScSymbol(function.try_into()?),
                args: args.try_into()?,
            }),
            auth: VecM::default(),
        }),
    };
    Ok(Transaction {
        source_account: MuxedAccount::Ed25519(Uint256(source.verifying_key().to_bytes())),
        fee: inclusion_fee,
        seq_num: SequenceNumber(sequence),
        cond: Preconditions::None,
        memo: Memo::None,
        operations: vec![op].try_into()?,
        ext: TransactionExt::V0,
    })
}

/// Applies a simulation to a transaction: its footprint and resources, the
/// authorization entries it recorded, and the resource fee on top of the
/// inclusion fee already set.
pub fn assemble(
    mut tx: Transaction,
    data: SorobanTransactionData,
    auth: Vec<SorobanAuthorizationEntry>,
    min_resource_fee: u64,
) -> Result<Transaction, Error> {
    let resource_fee = u32::try_from(min_resource_fee)?;
    tx.fee = tx.fee.checked_add(resource_fee).ok_or("fee overflow")?;
    tx.ext = TransactionExt::V1(data);
    let mut ops: Vec<Operation> = tx.operations.into();
    if let Some(Operation {
        body: OperationBody::InvokeHostFunction(op),
        ..
    }) = ops.first_mut()
    {
        op.auth = auth.try_into()?;
    }
    tx.operations = ops.try_into()?;
    Ok(tx)
}

pub fn network_id(passphrase: &str) -> [u8; 32] {
    Sha256::digest(passphrase.as_bytes()).into()
}

/// Signs the transaction for the network and wraps it in an envelope.
pub fn sign(
    tx: Transaction,
    key: &SigningKey,
    passphrase: &str,
) -> Result<TransactionEnvelope, Error> {
    let unsigned = TransactionEnvelope::Tx(TransactionV1Envelope {
        tx: tx.clone(),
        signatures: VecM::default(),
    });
    let hash = unsigned.hash(network_id(passphrase))?;
    let signature = key.sign(&hash);
    let public = key.verifying_key().to_bytes();
    let decorated = DecoratedSignature {
        hint: SignatureHint([public[28], public[29], public[30], public[31]]),
        signature: Signature(signature.to_bytes().to_vec().try_into()?),
    };
    Ok(TransactionEnvelope::Tx(TransactionV1Envelope {
        tx,
        signatures: vec![decorated].try_into()?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;
    use stellar_xdr::{LedgerFootprint, SorobanResources, SorobanTransactionDataExt};

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[3u8; 32])
    }

    #[test]
    fn builds_a_contract_call() {
        let tx = invoke(&key(), 42, [5u8; 32], "execute", vec![ScVal::U64(7)], 100).unwrap();
        assert_eq!(tx.seq_num, SequenceNumber(42));
        assert_eq!(tx.fee, 100);
        let OperationBody::InvokeHostFunction(op) = &tx.operations[0].body else {
            panic!("not an invoke");
        };
        let HostFunction::InvokeContract(call) = &op.host_function else {
            panic!("not a contract call");
        };
        assert_eq!(call.function_name.0.to_utf8_string_lossy(), "execute");
        assert_eq!(call.args.len(), 1);
        assert_eq!(call.contract_address, contract_address([5u8; 32]));
    }

    #[test]
    fn assembling_adds_the_simulation_and_resource_fee() {
        let tx = invoke(&key(), 1, [5u8; 32], "execute", vec![], 100).unwrap();
        let data = SorobanTransactionData {
            ext: SorobanTransactionDataExt::V0,
            resources: SorobanResources {
                footprint: LedgerFootprint {
                    read_only: VecM::default(),
                    read_write: VecM::default(),
                },
                instructions: 1_000,
                disk_read_bytes: 10,
                write_bytes: 20,
            },
            resource_fee: 5_000,
        };
        let assembled = assemble(tx, data.clone(), vec![], 5_000).unwrap();
        assert_eq!(assembled.fee, 5_100);
        assert_eq!(assembled.ext, TransactionExt::V1(data));
    }

    #[test]
    fn signature_verifies_against_the_network_hash() {
        let tx = invoke(&key(), 1, [5u8; 32], "execute", vec![], 100).unwrap();
        let passphrase = crate::config::TESTNET_PASSPHRASE;
        let TransactionEnvelope::Tx(env) = sign(tx.clone(), &key(), passphrase).unwrap() else {
            panic!("v1 envelope");
        };
        let unsigned = TransactionEnvelope::Tx(TransactionV1Envelope {
            tx,
            signatures: VecM::default(),
        });
        let hash = unsigned.hash(network_id(passphrase)).unwrap();
        let sig =
            ed25519_dalek::Signature::from_slice(env.signatures[0].signature.0.as_slice()).unwrap();
        key().verifying_key().verify(&hash, &sig).unwrap();
        // The same signature is wrong for another network.
        let other = unsigned
            .hash(network_id(crate::config::LOCAL_PASSPHRASE))
            .unwrap();
        assert!(key().verifying_key().verify(&other, &sig).is_err());
    }
}
