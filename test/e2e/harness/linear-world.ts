// The run's world in Linear: teams, the run's projects (created as an
// editor with neutral names and deleted afterwards), the editors' clients
// for scripted human edits, and cleanup that touches only what a run made.
// Fixture projects and anything else that is no run's are never written.

import { LinearClient, GraphQLTransport, type LinearDocument } from '../../../src/linear/index.ts';
import { runOfProject, runOfTeamTitle } from './isolation.ts';

/** Personal API keys go in the Authorization header as they are, without "Bearer". */
export function apiKeyFetch(base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    const value = headers.get('authorization');
    if (value?.startsWith('Bearer ')) headers.set('authorization', value.slice('Bearer '.length));
    return base(input, { ...init, headers });
  };
}

export function editorClient(apiKey: string, baseUrl?: string): LinearClient {
  return new LinearClient(new GraphQLTransport({ token: apiKey, baseUrl, fetch: apiKeyFetch() }));
}

export interface Team {
  id: string;
  key: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export class RunWorldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunWorldError';
  }
}

export class LinearWorld {
  readonly client: LinearClient;

  constructor(client: LinearClient) {
    this.client = client;
  }

  async teams(): Promise<Team[]> {
    const data = await this.client.request<{ teams: { nodes: Team[] } }>('Teams', 'query', 'query Teams { teams(first: 50) { nodes { id key name } } }');
    return data.teams.nodes;
  }

  async teamByKey(key: string): Promise<Team> {
    const team = (await this.teams()).find((candidate) => candidate.key === key);
    if (team === undefined) throw new RunWorldError(`the test workspace has no team with key ${key}`);
    return team;
  }

  /** Creates a run project. Its name must be a run project's name. */
  async createProject(name: string, teamIds: readonly string[]): Promise<Project> {
    if (runOfProject(name) === null) throw new RunWorldError(`refusing to create a project that is no run's: ${name}`);
    const data = await this.client.request<{ projectCreate: { success: boolean; project: Project } }>(
      'CreateProject',
      'mutation',
      'mutation CreateProject($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name createdAt } } }',
      { input: { name, teamIds } },
    );
    if (!data.projectCreate.success) throw new RunWorldError(`Linear did not create project ${name}`);
    return data.projectCreate.project;
  }

  /** Every project whose name is a run project's, with the run id. */
  async runProjects(): Promise<Array<Project & { runId: string }>> {
    const result: Array<Project & { runId: string }> = [];
    let after: string | null = null;
    for (;;) {
      const data: { projects: { nodes: Project[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.client.request(
        'RunProjects',
        'query',
        'query RunProjects($after: String) { projects(first: 100, after: $after) { nodes { id name createdAt } pageInfo { hasNextPage endCursor } } }',
        { after },
      );
      for (const project of data.projects.nodes) {
        const runId = runOfProject(project.name);
        if (runId !== null) result.push({ ...project, runId });
      }
      if (!data.projects.pageInfo.hasNextPage) return result;
      after = data.projects.pageInfo.endCursor;
    }
  }

  /** Deletes a run project (its documents go with it). Refuses any other project. */
  async deleteProject(project: Pick<Project, 'id' | 'name'>, runId: string): Promise<void> {
    if (runOfProject(project.name) !== runId) throw new RunWorldError(`refusing to delete project ${project.name}: not a project of run ${runId}`);
    await this.client.request('DeleteProject', 'mutation', 'mutation DeleteProject($id: String!) { projectDelete(id: $id) { success } }', { id: project.id });
  }

  /**
   * Team-zone documents (no project) of a team whose title starts with a run
   * id. With `trashed`, trashed ones are listed too. Cleanup asks for them for
   * its own run only; the sweeper does not, so it never touches trash that runs
   * left before the archive cleanup (freeing that is the owner's decision).
   */
  async runTeamDocuments(teamId: string, options: { trashed?: boolean } = {}): Promise<Array<LinearDocument & { runId: string }>> {
    const documents = await this.client.listDocuments({ teamId }, { includeArchived: options.trashed === true });
    return documents.flatMap((document) => {
      if (document.projectId !== null || (document.archivedAt !== null && !document.trashed)) return [];
      if (document.trashed && options.trashed !== true) return [];
      const runId = runOfTeamTitle(document.title);
      return runId === null ? [] : [{ ...document, runId }];
    });
  }

  /**
   * Archives a run's team-zone documents instead of trashing them: per team, it
   * moves them into a run project of that team and deletes the project, which
   * archives them, as Linear does for project documents. A trashed one is
   * restored first, and put back in the trash if it cannot be moved, so a
   * failure never leaves a live document in the zone. Trashed documents count
   * against a team zone's cap of about 1,000 documents and the API cannot
   * purge them; archived ones do not count. Refuses any document that is not
   * one of the run's. Every team and document is tried; the failures are
   * thrown together at the end.
   */
  async archiveRunTeamDocuments(
    documents: ReadonlyArray<Pick<LinearDocument, 'id' | 'title' | 'projectId' | 'teamId' | 'trashed'>>,
    runId: string,
    projectName: string,
    isRuns: (document: Pick<LinearDocument, 'id' | 'title'>) => boolean = (document) => runOfTeamTitle(document.title) === runId,
  ): Promise<number> {
    const byTeam = new Map<string, Array<(typeof documents)[number]>>();
    const problems: string[] = [];
    for (const document of documents) {
      if (document.projectId !== null) continue;
      if (!isRuns(document)) throw new RunWorldError(`refusing to archive a document that is not a team-zone document of run ${runId}`);
      if (document.teamId === null) {
        problems.push(`document ${document.id} has neither a project nor a team`);
        continue;
      }
      const list = byTeam.get(document.teamId) ?? [];
      list.push(document);
      byTeam.set(document.teamId, list);
    }
    let archived = 0;
    for (const [teamId, teamDocuments] of byTeam) {
      let project: Project;
      try {
        project = await this.createProject(projectName, [teamId]);
      } catch (error) {
        problems.push(`team ${teamId}: ${(error as Error).message}`);
        continue;
      }
      for (const document of teamDocuments) {
        try {
          if (document.trashed) await this.client.restoreDocument(document.id);
          try {
            await this.client.updateDocument(document.id, { projectId: project.id });
          } catch (error) {
            if (document.trashed) await this.client.trashDocument(document.id).catch(() => {});
            throw error;
          }
          archived += 1;
        } catch (error) {
          problems.push(`document ${document.id}: ${(error as Error).message}`);
        }
      }
      try {
        await this.deleteProject(project, runId);
      } catch (error) {
        problems.push(`project of team ${teamId}: ${(error as Error).message}`);
      }
    }
    if (problems.length > 0) throw new RunWorldError(`archived ${archived}; not archived: ${problems.join('; ')}`);
    return archived;
  }

  /** Trashed documents in a team's zone (not in a project): the count that runs into the zone's cap. */
  async trashedInZone(teamId: string): Promise<number> {
    const documents = await this.client.listDocuments({ teamId }, { includeArchived: true });
    return documents.filter((document) => document.trashed && document.projectId === null).length;
  }

}
