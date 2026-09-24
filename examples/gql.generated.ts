import * as z from 'zod'
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  DateTime: { input: string; output: string; }
};

export type Mutation = {
  __typename?: 'Mutation';
  createTask: Task;
};


export type MutationCreateTaskArgs = {
  body?: InputMaybe<Scalars['String']['input']>;
  title: Scalars['String']['input'];
};

export type PageInfo = {
  __typename?: 'PageInfo';
  endCursor?: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
};

export type Query = {
  __typename?: 'Query';
  task?: Maybe<Task>;
  tasks: TaskConnection;
};


export type QueryTaskArgs = {
  id: Scalars['ID']['input'];
};


export type QueryTasksArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  filter?: InputMaybe<TaskFilter>;
  first: Scalars['Int']['input'];
};

export type Task = {
  __typename?: 'Task';
  createdAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  status: TaskStatus;
  title: Scalars['String']['output'];
};

export type TaskConnection = {
  __typename?: 'TaskConnection';
  edges: Array<TaskEdge>;
  pageInfo: PageInfo;
};

export type TaskEdge = {
  __typename?: 'TaskEdge';
  cursor: Scalars['String']['output'];
  node: Task;
};

export type TaskFilter = {
  query?: InputMaybe<Scalars['String']['input']>;
  status?: InputMaybe<TaskStatus>;
};

export const TaskStatus = {
  Done: "DONE",
  Open: "OPEN",
} as const
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]


type Properties<T> = {
  [K in keyof T]: z.ZodType<T[K], T[K] | undefined>;
};

type definedNonNullAny = {};

export const isDefinedNonNullAny = (v: any): v is definedNonNullAny => v !== undefined && v !== null;

export const definedNonNullAnySchema = z.any().refine((v) => isDefinedNonNullAny(v));

export const TaskStatusSchema: z.ZodType<TaskStatus, TaskStatus> = z.enum(["DONE", "OPEN"])

export function PageInfoSchema(): z.ZodObject<Properties<PageInfo>> {
  return z.object({
    __typename: z.literal('PageInfo').optional(),
    endCursor: z.string().nullish(),
    hasNextPage: z.boolean()
  })
}

export function TaskSchema(): z.ZodObject<Properties<Task>> {
  return z.object({
    __typename: z.literal('Task').optional(),
    createdAt: z.iso.datetime(),
    id: z.string(),
    status: TaskStatusSchema,
    title: z.string()
  })
}

export function TaskEdgeSchema() {
  return z.object({
    __typename: z.literal('TaskEdge').optional(),
    cursor: z.string(),
    node: TaskSchema()
  })
}

export function TaskConnectionSchema() {
  return z.object({
    __typename: z.literal('TaskConnection').optional(),
    edges: z.array(TaskEdgeSchema()),
    pageInfo: PageInfoSchema()
  })
}

export function TaskFilterSchema(): z.ZodObject<Properties<TaskFilter>> {
  return z.object({
    query: z.string().nullish(),
    status: TaskStatusSchema.nullish()
  })
}
