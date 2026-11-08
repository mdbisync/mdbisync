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

  /** Team-zone documents (no project) of a team whose title starts with a run id. */
  async runTeamDocuments(teamId: string): Promise<Array<LinearDocument & { runId: string }>> {
    const documents = await this.client.listDocuments({ teamId }, { includeArchived: false });
    return documents.flatMap((document) => {
      const runId = document.projectId === null ? runOfTeamTitle(document.title) : null;
      return runId === null ? [] : [{ ...document, runId }];
    });
  }

  /**
   * Moves the given documents to the trash when they are team-zone documents
   * (no project). The ids come from the run itself (seeded or recorded).
   */
  async trashTeamZoneDocuments(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let trashed = 0;
    for (const document of await this.client.getDocuments(ids)) {
      if (document.projectId !== null || document.trashed) continue;
      await this.client.trashDocument(document.id);
      trashed += 1;
    }
    return trashed;
  }

  /**
   * Team-zone documents titled exactly "README" that this editor created:
   * leftovers of seeding a team zone's own annotation file, which carries no
   * run prefix. Only the sweeper removes them, while it holds the team's lock.
   */
  async strayTeamReadmes(teamId: string): Promise<Array<{ id: string; createdAt: string }>> {
    const data = await this.client.request<{
      viewer: { id: string };
      documents: { nodes: Array<{ id: string; title: string; createdAt: string; project: { id: string } | null; creator: { id: string } | null }> };
    }>(
      'StrayTeamReadmes',
      'query',
      'query StrayTeamReadmes($teamId: ID!) { viewer { id } documents(first: 250, filter: { team: { id: { eq: $teamId } }, title: { eq: "README" } }) { nodes { id title createdAt project { id } creator { id } } } }',
      { teamId },
    );
    return data.documents.nodes
      .filter((document) => document.title === 'README' && document.project === null && document.creator?.id === data.viewer.id)
      .map(({ id, createdAt }) => ({ id, createdAt }));
  }

  /** Moves a run's team-zone document to the trash. Refuses any other document. */
  async trashRunDocument(document: Pick<LinearDocument, 'id' | 'title' | 'projectId'>, runId: string): Promise<void> {
    if (document.projectId !== null || runOfTeamTitle(document.title) !== runId) {
      throw new RunWorldError(`refusing to trash a document that is not a team-zone document of run ${runId}`);
    }
    await this.client.trashDocument(document.id);
  }
}
