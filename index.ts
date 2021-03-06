import 'source-map-support/register'
import * as azure from 'azure-storage'
import * as fs from 'fs'
import * as p from 'path'
import * as tty from 'tty'
import * as util from 'util'
var [nodeExe, currentFile, storageAccount, storageAccessKey, fileShare, localFolder] = global.process.argv;
var files = new azure.FileService(storageAccount, storageAccessKey);
if (!localFolder)
    throw new Error('no folder to sync with was specified');

browseRemote().then(async function (tree)
{
    console.log('browsed root');

    var saved = await load();
    var comparison = await compareTrees(tree, saved || {});
    await save(tree);

    comparison = comparison.filter(c => c.type == 'right-missing');
    if (!comparison.length)
    {
        var local = await browseLocal('');
        comparison = await compareTrees(tree, local, { compareLength: true });
    }
    if (comparison.length)
    {
        console.log(comparison);
        var progresses: azure.common.streams.speedsummary.SpeedSummary[] = process(comparison, { dryrun: !!~global.process.argv.indexOf('dryrun') }).filter(s => s !== null) as any;
        await Promise.all(progresses.map(progress));

    }

});

function progress(progress: azure.common.streams.speedsummary.SpeedSummary, lineNumber: number): Promise<void>
{
    if (!global.process.stdout.isTTY)
        return new Promise((resolve) =>
        {
            progress.on('progress', function ()
            {
                if (progress.completeSize == progress.totalSize)
                    resolve()
            });
        });
    var out = global.process.stdout as tty.WriteStream;
    out.clearLine(0)
    out.cursorTo(0, out.rows - lineNumber - 1);
    if (progress.completeSize == progress.totalSize)
        out.write(`${progress.name} downloaded at ${progress.getAverageSpeed(true)}`);
    else
        out.write(`${progress.name}`);

    // var interval = setInterval(function ()
    return new Promise((resolve) =>
    {
        progress.on('progress', function ()
        {
            out.clearLine(0)
            out.cursorTo(0, out.rows - lineNumber - 1);
            if (progress.completeSize == progress.totalSize)
            {
                out.write(`${progress.name} downloaded at ${progress.getAverageSpeed(true)}`);
                resolve();
                // clearInterval(interval);
            }
            else
            {
                var sizeProgress = progress.getCompleteSize(true) + '/' + progress.getTotalSize(true);
                var speed = progress.getSpeed(true) as string;
                var placeLeft = out.columns - speed.length - sizeProgress.length - 2;
                var str: string = ''
                if (placeLeft > progress.name.length)
                    str = progress.name;
                else
                    str = progress.name.substring(0, progress.name.length - placeLeft - 3) + '...';

                str += ' ' + sizeProgress;
                str += speed.padStart(out.columns - str.length - speed.length);
                out.write(str);
            }
        });
    });
    // }, 1000);

}

function process(comparison: CompareResult[], options: { dryrun: boolean })
{
    return comparison.map(c =>
    {
        switch (c.type)
        {
            case "different-checksum":
            case "left-bigger":
            case "right-missing":
            case "right-older":
                console.log(`downloading ${fileShare} ${c.file.directory} ${c.file.name}`);
                if (options.dryrun)
                    return null;
                if (!fs.existsSync(p.join(localFolder, c.file.directory)))
                    fs.mkdirSync(p.join(localFolder, c.file.directory), { recursive: true });
                var destination = fs.createWriteStream(p.join(localFolder, c.file.directory, c.file.name));

                var progress = files.getFileToStream(fileShare, c.file.directory, c.file.name, destination, function (error, result)
                {
                    if (error)
                        console.error(`failed to download ${c.file.directory} ${c.file.name}`)
                    else
                        console.log(`successfully downloaded ${c.file.directory} ${c.file.name}`)
                });
                return progress;
            case "left-older":
            case "right-bigger":
            case "left-missing":
                return null;
        }
    });
}

type Tree = { [path: string]: azure.FileService.FileResult[] };
type SavedTree = { [path: string]: { name: string, etag: string, lastModified: string, length: string }[] };

function browseLocal(folder: string): PromiseLike<Tree>
{
    return new Promise<Tree>(async function (resolve, reject) 
    {
        var tree: { [path: string]: azure.FileService.FileResult[] } = {};
        fs.readdir(p.join(localFolder, folder), async function (err, result)
        {
            if (err)
            {
                console.error(`failed to list files for folder ${folder}`)
                reject(err);
            }
            else
            {
                await Promise.all(result.map(async (d) =>
                {
                    var stat = await util.promisify(fs.lstat)(p.join(localFolder, folder, d));
                    if (stat.isDirectory())
                    {
                        var files = await browseLocal(p.join(folder, d))
                        Object.keys(files).forEach((p) =>
                        {
                            if (typeof tree[p.replace('\\', '/')] == 'undefined')
                                tree['/' + p.replace('\\', '/')] = files[p];
                            else
                                tree['/' + p.replace('\\', '/')] = tree['/' + p.replace('\\', '/')].concat(files[p]);
                        });
                    }
                    else
                    {
                        if (typeof tree[folder || ''] == 'undefined')
                            tree[folder || ''] = [];
                        tree[folder || ''].push({ name: d, directory: folder, contentLength: stat.size.toString(), lastModified: stat.mtime.toISOString() } as azure.FileService.FileResult);
                    }
                }));
                resolve(tree);
            }
        });
    });
}

function save(tree: Tree)
{
    new Promise((resolve, reject) =>
    {
        var objectToSave: SavedTree = {}
        Object.keys(tree).map((path) =>
        {
            objectToSave[path] = tree[path].map(f => { return { name: f.name, etag: f.etag, lastModified: f.lastModified, length: f.contentLength }; });
        });
        fs.writeFile('./remote-tree.json', JSON.stringify(objectToSave, null, 4), { encoding: 'utf8' }, (err) =>
        {
            if (err)
                reject(err);
            else
                resolve();
        });
    })
}

function load(): PromiseLike<Tree | null>
{
    var tree: Tree = {};
    return new Promise<Tree | null>((resolve, reject) =>
    {
        fs.exists('./remote-tree.json', function (exists)
        {
            if (!exists)
                resolve(null);
            else
                fs.readFile('./remote-tree.json', { encoding: 'utf8' }, (err, data) =>
                {
                    if (err)
                    {
                        reject(err);
                        return;
                    }
                    var objectToSave: SavedTree = JSON.parse(data);
                    Object.keys(objectToSave).map((path) =>
                    {
                        tree[path] = objectToSave[path].map(f =>
                        {
                            return {
                                directory: path, name: f.name, etag: f.etag, lastModified: f.lastModified, contentLength: f.length
                                , share: fileShare, acceptRanges: '', contentRange: ''
                            };
                        });
                    });

                    resolve(tree);

                });
        })
    })
}

function browseRemote(folder?: string, token?: azure.common.ContinuationToken): PromiseLike<Tree>
{
    // console.debug(`browsing ${folder}`)
    return new Promise(async (resolve, reject) =>
    {
        var tree: { [path: string]: azure.FileService.FileResult[] } = {};
        files.listFilesAndDirectoriesSegmented(fileShare, folder || '', token as azure.common.ContinuationToken, async function (err, result)
        {
            if (err)
            {
                console.error(`failed to list files for folder ${folder}`)
                reject(err);
            }
            else
            {
                if (result.continuationToken)
                {
                    var subTree = await browseRemote(folder || '', result.continuationToken);
                    Object.assign(tree, subTree);
                }
                await Promise.all(result.entries.directories.map(async (d) =>
                {
                    var files = await browseRemote((folder || '') + '/' + d.name);
                    Object.keys(files).forEach((p) =>
                    {
                        if (typeof tree[p] == 'undefined')
                            tree[p] = files[p];
                        else
                            tree[p] = tree[p].concat(files[p]);
                    });
                }));

                result.entries.files.filter(f =>
                {
                    f.directory = folder || '';
                    return true;
                });

                if (typeof tree[folder || ''] == 'undefined')
                    tree[folder || ''] = result.entries.files;
                else
                    tree[folder || ''] = tree[folder || ''].concat(result.entries.files);
            }
            resolve(tree);
        })
    });
}

type CompareResult = { type: 'right-missing' | 'left-missing' | 'right-older' | 'left-older' | 'right-bigger' | 'left-bigger' | 'different-checksum', file: azure.FileService.FileResult };

function compareTrees(left: Tree, right: Tree, options: { compareLength?: boolean, compareChecksum?: boolean } = {}): PromiseLike<CompareResult[]>
{
    var commands: CompareResult[] = [];
    return Promise.all(Object.keys(left).map(async (path) =>
    {
        if (typeof right[path] == 'undefined')
            left[path].forEach(function (file)
            {
                commands.push({ type: 'right-missing', file })
            })
        else
            await Promise.all(left[path].map(async function (leftFile)
            {
                var rightFile = right[path].find(f => f.name == leftFile.name);
                if (!rightFile)
                    commands.push({ type: 'right-missing', file: leftFile });
                else
                {
                    if (options.compareLength)
                    {
                        if (leftFile.contentLength != rightFile.contentLength)
                        {
                            if (leftFile.contentLength < rightFile.contentLength)
                                commands.push({ type: 'right-bigger', file: rightFile })
                            else
                                commands.push({ type: 'left-bigger', file: leftFile })
                        }
                        else
                            files.getFileProperties(fileShare, leftFile.directory, leftFile.name, function (err, leftFile)
                            {
                                if (err)
                                    throw err;
                                leftFile.lastModified = new Date(leftFile.lastModified).toISOString();
                                if (rightFile)
                                    if (leftFile.lastModified > rightFile.lastModified)
                                    {
                                        commands.push({ type: 'right-older', file: leftFile });
                                        Object.assign(rightFile, leftFile);
                                    }
                                    else if (leftFile.lastModified < rightFile.lastModified)
                                    {
                                        commands.push({ type: 'left-older', file: leftFile });
                                        Object.assign(rightFile, leftFile);
                                    }
                                    else
                                    {
                                        if (options.compareChecksum && leftFile.etag != rightFile.etag)
                                        {
                                            commands.push({ type: 'different-checksum', file: leftFile });
                                            Object.assign(rightFile, leftFile);
                                        }
                                    }
                            })
                    }
                }
            }));
    })).then(() => { return commands });
}