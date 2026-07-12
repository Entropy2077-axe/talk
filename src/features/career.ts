import { lazy } from 'react'
import type { FeatureModule } from './types'

const WorkPage = lazy(() => import('../pages/WorkPage').then(({ WorkPage }) => ({ default: WorkPage })))
const InterviewPage = lazy(() => import('../pages/InterviewPage').then(({ InterviewPage }) => ({ default: InterviewPage })))
export const careerModule: FeatureModule = {
  id: 'career', name: '职业', icon: '💼', description: '职业、工资、求职面试与金钱互动', parentId: 'more-interaction',
  routes: [{ path: '/work', component: WorkPage }, { path: '/work/interview/:jobId', component: InterviewPage }],
  discoverEntries: [{ to: '/work', icon: '💼', label: '工作' }], linkApps: [{ app: 'work', desc: '求职与职业小程序' }],
}
