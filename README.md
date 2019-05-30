# azure-file-sync

# How to use

```
git clone https://github.com/npenin/azure-file-sync.git
yarn
node . <storageAccount> <storageAccessKey> <storageFileShare> <localfolder> [dryrun]
```

# How it works
On the first run, it will just build a metadata file (remote-tree.json) and download everything from the file share (this assumes that the folder you are syncing with is empty).
if it is not empty, please use the dryrun, so that only the metadata file is build.
On any new run, it will compare the metadata file and the remote file share. If there is no differencem, it will compare metadata file with local file. Any discrepancy between local and metadata will be identified, and most of them will trigger a new download from the storage account


# ideas
- create an optional 2-way sync
- reuse the same logic to sync 2 local folders
